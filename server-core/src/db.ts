import { createHash } from "node:crypto";
import { bytesToBase64Url, randomBytes } from "../../shared/src/codec";
import { autoVersionsToDrop, type SyncTrigger } from "../../shared/src/history";
import type { AppConfig } from "./config";
import { openMysql, openPostgres, openSqlite, type Queryable } from "./sql";

export interface Account {
  id: string;
  subject: string;
  displayName: string;
  createdAt: number;
}

export type Encoding = "e2ee" | "plain";

export interface ObjectRow {
  accountId: string;
  fileId: string;
  vaultName: string;
  pathCipher: string;
  contentMac: string;
  size: number;
  mtime: number;
  updatedAt: number;
  encoding: Encoding;
  rev: number;
  pathMac: string;
}

export interface ChangeRow {
  seq: number;
  op: "upsert" | "delete";
  fileId: string;
  rev: number;
  contentMac: string;
  size: number;
  mtime: number;
  updatedAt: number;
  encoding: Encoding;
}

export type PutRevisionResult =
  | { status: "created" | "updated" | "unchanged"; row: ObjectRow; droppedVersionIds: string[] }
  | { status: "conflict"; reason: "parent_rev" | "deleted"; current: ObjectRow | null };

export interface FileVersionRow {
  accountId: string;
  versionId: string;
  fileId: string;
  vaultName: string;
  pathCipher: string;
  contentMac: string;
  size: number;
  mtime: number;
  createdAt: number;
  encoding: Encoding;
  tipRev: number;
  syncTrigger: SyncTrigger;
}

export interface RetentionRow {
  autoLimit: number;
  manualLimit: number | null;
}

export interface VaultStatRow {
  id: string;
  name: string;
  files: number;
  bytes: number;
  lastSyncAt: number;
  encrypted: boolean;
}

export interface RecentRow {
  vaultName: string;
  size: number;
  updatedAt: number;
  encoding: Encoding;
}

interface AccountRow {
  id: string;
  subject: string;
  display_name: string;
  created_at: number | string;
}

interface ObjectSqlRow {
  account_id: string;
  file_id: string;
  vault_name: string | null;
  path_cipher: string;
  content_mac: string;
  size: number | string;
  mtime: number | string;
  updated_at: number | string;
  encoding: string | null;
  rev: number | string | null;
  path_mac?: string | null;
}

interface ChangeSqlRow {
  seq: number | string;
  op: string;
  file_id: string;
  rev: number | string | null;
  content_mac: string | null;
  size: number | string | null;
  mtime: number | string | null;
  updated_at: number | string;
  encoding: string | null;
}

const OBJECT_COLUMNS = "account_id, file_id, vault_name, path_cipher, content_mac, size, mtime, updated_at, encoding, rev, path_mac";
const VERSION_COLUMNS = "account_id, version_id, file_id, vault_name, path_cipher, content_mac, size, mtime, created_at, encoding, tip_rev, sync_trigger";

interface VersionSqlRow {
  account_id: string;
  version_id: string;
  file_id: string;
  vault_name: string | null;
  path_cipher: string;
  content_mac: string;
  size: number | string;
  mtime: number | string;
  created_at: number | string;
  encoding: string | null;
  tip_rev: number | string | null;
  sync_trigger: string | null;
}

export class SyncDb {
  constructor(private readonly sql: Queryable) {}

  get dialect(): Queryable["dialect"] {
    return this.sql.dialect;
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  async findAccountBySubject(subject: string): Promise<Account | undefined> {
    const row = await this.sql.get<AccountRow>(
      "SELECT id, subject, display_name, created_at FROM accounts WHERE subject = ?",
      [subject],
    );
    return mapAccount(row);
  }

  async findAccount(id: string): Promise<Account | undefined> {
    const row = await this.sql.get<AccountRow>(
      "SELECT id, subject, display_name, created_at FROM accounts WHERE id = ?",
      [id],
    );
    return mapAccount(row);
  }

  async upsertAccount(subject: string, displayName: string): Promise<Account> {
    const existing = await this.findAccountBySubject(subject);
    if (existing) {
      await this.sql.run("UPDATE accounts SET display_name = ? WHERE id = ?", [displayName, existing.id]);
      return { ...existing, displayName };
    }
    const account: Account = {
      id: crypto.randomUUID(),
      subject,
      displayName,
      createdAt: Date.now(),
    };
    await this.sql.run(
      "INSERT INTO accounts (id, subject, display_name, created_at) VALUES (?, ?, ?, ?)",
      [account.id, account.subject, account.displayName, account.createdAt],
    );
    return account;
  }

  async ensureSingleAccount(): Promise<Account> {
    return this.upsertAccount("single:default", "Single account");
  }

  async createDeviceCode(code: string, expiresAt: number): Promise<void> {
    await this.sql.run("INSERT INTO device_codes (code, account_id, expires_at) VALUES (?, NULL, ?)", [code, expiresAt]);
  }

  async claimDeviceCode(code: string, accountId: string): Promise<boolean> {
    const changes = await this.sql.run(
      "UPDATE device_codes SET account_id = ? WHERE code = ? AND account_id IS NULL AND expires_at > ?",
      [accountId, code, Date.now()],
    );
    return changes > 0;
  }

  async createLoginCode(code: string, accountId: string, state: string, expiresAt: number): Promise<void> {
    await this.sql.run("DELETE FROM login_codes WHERE expires_at <= ?", [Date.now()]);
    await this.sql.run(
      "INSERT INTO login_codes (code, account_id, state, expires_at) VALUES (?, ?, ?, ?)",
      [code, accountId, state, expiresAt],
    );
  }

  async takeLoginCode(code: string, state: string): Promise<string | undefined> {
    const row = await this.sql.get<{ account_id: string; state: string; expires_at: number | string }>(
      "SELECT account_id, state, expires_at FROM login_codes WHERE code = ?",
      [code],
    );
    if (!row) return undefined;
    await this.sql.run("DELETE FROM login_codes WHERE code = ?", [code]);
    if (Number(row.expires_at) <= Date.now() || row.state !== state) return undefined;
    return row.account_id;
  }

  async takeDeviceAccount(code: string): Promise<string | null | undefined> {
    const row = await this.sql.get<{ account_id: string | null; expires_at: number | string }>(
      "SELECT account_id, expires_at FROM device_codes WHERE code = ?",
      [code],
    );
    if (!row || Number(row.expires_at) <= Date.now()) {
      if (row) await this.sql.run("DELETE FROM device_codes WHERE code = ?", [code]);
      return undefined;
    }
    if (!row.account_id) return null;
    await this.sql.run("DELETE FROM device_codes WHERE code = ?", [code]);
    return row.account_id;
  }

  async replacePairingCode(accountId: string, code: string, expiresAt: number): Promise<void> {
    await this.sql.run("DELETE FROM pairing_codes WHERE account_id = ? OR expires_at <= ?", [accountId, Date.now()]);
    await this.sql.run("INSERT INTO pairing_codes (code, account_id, expires_at) VALUES (?, ?, ?)", [code, accountId, expiresAt]);
  }

  async takePairingCode(code: string): Promise<string | undefined> {
    const row = await this.sql.get<{ account_id: string; expires_at: number | string }>(
      "SELECT account_id, expires_at FROM pairing_codes WHERE code = ?",
      [code],
    );
    if (!row) return undefined;
    await this.sql.run("DELETE FROM pairing_codes WHERE code = ?", [code]);
    if (Number(row.expires_at) <= Date.now()) return undefined;
    return row.account_id;
  }

  async upsertCredential(accountId: string, authKey: string): Promise<void> {
    const now = Date.now();
    const existing = await this.findAuthKey(accountId);
    if (existing) {
      await this.sql.run("UPDATE credentials SET auth_key = ?, updated_at = ? WHERE account_id = ?", [authKey, now, accountId]);
      return;
    }
    await this.sql.run(
      "INSERT INTO credentials (account_id, auth_key, updated_at) VALUES (?, ?, ?)",
      [accountId, authKey, now],
    );
  }

  async findAuthKey(accountId: string): Promise<string | undefined> {
    const row = await this.sql.get<{ auth_key: string }>(
      "SELECT auth_key FROM credentials WHERE account_id = ?",
      [accountId],
    );
    return row?.auth_key;
  }

  async hasCredential(accountId: string): Promise<boolean> {
    return Boolean(await this.findAuthKey(accountId));
  }

  async issueToken(accountId: string, ttlMs: number): Promise<string> {
    const token = bytesToBase64Url(randomBytes(32));
    const now = Date.now();
    await this.sql.run(
      "INSERT INTO api_tokens (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      [hashToken(token), accountId, now, now + ttlMs],
    );
    return token;
  }

  async findAccountByToken(token: string): Promise<string | undefined> {
    if (!token || token.length > 200) return undefined;
    const row = await this.sql.get<{ account_id: string; expires_at: number | string | null }>(
      "SELECT account_id, expires_at FROM api_tokens WHERE token_hash = ?",
      [hashToken(token)],
    );
    if (!row) return undefined;
    if (Number(row.expires_at) <= Date.now()) {
      await this.sql.run("DELETE FROM api_tokens WHERE token_hash = ?", [hashToken(token)]);
      return undefined;
    }
    return row.account_id;
  }

  async revokeToken(token: string): Promise<void> {
    if (!token || token.length > 200) return;
    await this.sql.run("DELETE FROM api_tokens WHERE token_hash = ?", [hashToken(token)]);
  }

  async listObjects(accountId: string, vaultName: string): Promise<ObjectRow[]> {
    const rows = await this.sql.all<ObjectSqlRow>(`
      SELECT ${OBJECT_COLUMNS}
      FROM objects WHERE account_id = ? AND vault_name = ? ORDER BY file_id
    `, [accountId, vaultName]);
    return rows.map(mapObject);
  }

  async findObject(accountId: string, fileId: string): Promise<ObjectRow | undefined> {
    const row = await this.sql.get<ObjectSqlRow>(`
      SELECT ${OBJECT_COLUMNS}
      FROM objects WHERE account_id = ? AND file_id = ?
    `, [accountId, fileId]);
    return row ? mapObject(row) : undefined;
  }

  async vaultCursor(accountId: string, vaultName: string): Promise<number> {
    const row = await this.sql.get<{ seq: number | string }>(
      "SELECT seq FROM vault_cursors WHERE account_id = ? AND vault_name = ?",
      [accountId, vaultName],
    );
    return Number(row?.seq ?? 0);
  }

  async listChanges(accountId: string, vaultName: string, since: number, limit: number): Promise<{
    changes: ChangeRow[];
    cursor: number;
    more: boolean;
  }> {
    const head = await this.vaultCursor(accountId, vaultName);
    const rows = await this.sql.all<ChangeSqlRow>(`
      SELECT seq, op, file_id, rev, content_mac, size, mtime, updated_at, encoding
      FROM changes
      WHERE account_id = ? AND vault_name = ? AND seq > ?
      ORDER BY seq
      LIMIT ?
    `, [accountId, vaultName, since, limit + 1]);
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const cursor = more ? Number(page[page.length - 1]?.seq ?? since) : head;
    return { changes: page.map(mapChange), cursor, more };
  }

  async listVaultStats(accountId: string): Promise<VaultStatRow[]> {
    const objectRows = await this.sql.all<{ name: string | null; files: number | string; bytes: number | string; last_sync: number | string; encrypted: number | string }>(`
      SELECT vault_name AS name, COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes, MAX(updated_at) AS last_sync,
        MAX(CASE WHEN encoding = 'e2ee' THEN 1 ELSE 0 END) AS encrypted
      FROM objects WHERE account_id = ?
      GROUP BY vault_name
    `, [accountId]);
    const policies = await this.sql.all<{ vault_name: string; encrypted: number | string; vault_id: string | null }>(
      "SELECT vault_name, encrypted, vault_id FROM vault_policies WHERE account_id = ?",
      [accountId],
    );
    const map = new Map<string, VaultStatRow>();
    for (const policy of policies) {
      const id = policy.vault_id || await this.assignVaultId(accountId, policy.vault_name);
      map.set(policy.vault_name, {
        id,
        name: policy.vault_name,
        files: 0,
        bytes: 0,
        lastSyncAt: 0,
        encrypted: Number(policy.encrypted) === 1,
      });
    }
    for (const row of objectRows) {
      const name = row.name ?? "";
      if (!name) continue;
      const current = map.get(name) ?? {
        id: await this.rememberVault(accountId, name, Number(row.encrypted) === 1),
        name,
        files: 0,
        bytes: 0,
        lastSyncAt: 0,
        encrypted: false,
      };
      current.files = Number(row.files);
      current.bytes = Number(row.bytes);
      current.lastSyncAt = Number(row.last_sync);
      current.encrypted = current.encrypted || Number(row.encrypted) === 1;
      map.set(name, current);
    }
    return [...map.values()].sort((a, b) => b.lastSyncAt - a.lastSyncAt);
  }

  async findVaultById(accountId: string, vaultId: string): Promise<{ id: string; name: string; encrypted: boolean } | undefined> {
    const row = await this.sql.get<{ vault_name: string; encrypted: number | string; vault_id: string }>(
      "SELECT vault_name, encrypted, vault_id FROM vault_policies WHERE account_id = ? AND vault_id = ?",
      [accountId, vaultId],
    );
    if (!row?.vault_id) return undefined;
    return { id: row.vault_id, name: row.vault_name, encrypted: Number(row.encrypted) === 1 };
  }

  async findVaultByName(accountId: string, vaultName: string): Promise<{ id: string; name: string; encrypted: boolean } | undefined> {
    const row = await this.sql.get<{ vault_name: string; encrypted: number | string; vault_id: string | null }>(
      "SELECT vault_name, encrypted, vault_id FROM vault_policies WHERE account_id = ? AND vault_name = ?",
      [accountId, vaultName],
    );
    if (!row) return undefined;
    const id = row.vault_id || await this.assignVaultId(accountId, row.vault_name);
    return { id, name: row.vault_name, encrypted: Number(row.encrypted) === 1 };
  }

  async createVault(accountId: string, vaultName: string, encrypted: boolean): Promise<string | "duplicate"> {
    const existing = await this.findVaultByName(accountId, vaultName);
    if (existing) return "duplicate";
    return this.rememberVault(accountId, vaultName, encrypted);
  }

  async vaultEncrypted(accountId: string, vaultName: string): Promise<boolean> {
    const row = await this.sql.get<{ encrypted: number | string }>(
      "SELECT encrypted FROM vault_policies WHERE account_id = ? AND vault_name = ?",
      [accountId, vaultName],
    );
    return Number(row?.encrypted ?? 0) === 1;
  }

  async rememberVault(accountId: string, vaultName: string, encrypted: boolean): Promise<string> {
    const row = await this.sql.get<{ encrypted: number | string; vault_id: string | null }>(
      "SELECT encrypted, vault_id FROM vault_policies WHERE account_id = ? AND vault_name = ?",
      [accountId, vaultName],
    );
    if (!row) {
      const id = crypto.randomUUID();
      await this.sql.run(
        "INSERT INTO vault_policies (account_id, vault_name, encrypted, vault_id) VALUES (?, ?, ?, ?)",
        [accountId, vaultName, encrypted ? 1 : 0, id],
      );
      return id;
    }
    const id = row.vault_id || await this.assignVaultId(accountId, vaultName);
    if (encrypted && Number(row.encrypted) !== 1) {
      await this.sql.run(
        "UPDATE vault_policies SET encrypted = 1 WHERE account_id = ? AND vault_name = ?",
        [accountId, vaultName],
      );
    }
    return id;
  }

  private async assignVaultId(accountId: string, vaultName: string): Promise<string> {
    const id = crypto.randomUUID();
    await this.sql.run(
      "UPDATE vault_policies SET vault_id = ? WHERE account_id = ? AND vault_name = ? AND (vault_id IS NULL OR vault_id = '')",
      [id, accountId, vaultName],
    );
    const row = await this.sql.get<{ vault_id: string }>(
      "SELECT vault_id FROM vault_policies WHERE account_id = ? AND vault_name = ?",
      [accountId, vaultName],
    );
    return row?.vault_id || id;
  }

  async listRecent(accountId: string, limit: number): Promise<RecentRow[]> {
    const rows = await this.sql.all<{ vault_name: string | null; size: number | string; updated_at: number | string; encoding: string | null }>(`
      SELECT vault_name, size, updated_at, encoding
      FROM objects WHERE account_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `, [accountId, limit]);
    return rows.map((row) => ({
      vaultName: row.vault_name ?? "",
      size: Number(row.size),
      updatedAt: Number(row.updated_at),
      encoding: row.encoding === "plain" ? "plain" : "e2ee",
    }));
  }

  async putObjectRevision(
    row: Omit<ObjectRow, "rev" | "updatedAt">,
    parentRev: number | null,
    writeBlob: () => Promise<void>,
    renamed = false,
    recordVersion?: (row: ObjectRow) => Promise<string[]>,
  ): Promise<PutRevisionResult> {
    await this.sql.exec("BEGIN");
    try {
      const existing = await this.findObject(row.accountId, row.fileId);
      if (existing && existing.contentMac === row.contentMac && existing.encoding === row.encoding) {
        const samePath = existing.vaultName === row.vaultName
          && existing.pathMac !== ""
          && existing.pathMac === row.pathMac;
        const backfill = !renamed && existing.vaultName === row.vaultName
          && (existing.pathMac === "" || existing.pathMac === row.pathMac);
        if (samePath || backfill) {
          if (existing.pathMac === "" && row.pathMac) {
            await this.sql.run(
              "UPDATE objects SET path_cipher = ?, path_mac = ? WHERE account_id = ? AND file_id = ?",
              [row.pathCipher, row.pathMac, row.accountId, row.fileId],
            );
          }
          await this.sql.exec("COMMIT");
          return { status: "unchanged", row: existing, droppedVersionIds: [] };
        }
        if (parentRev === null || parentRev !== existing.rev) {
          await this.sql.exec("COMMIT");
          return { status: "conflict", reason: "parent_rev", current: existing };
        }
        const moved: ObjectRow = {
          ...existing,
          vaultName: row.vaultName,
          pathCipher: row.pathCipher,
          pathMac: row.pathMac,
          mtime: row.mtime,
          rev: existing.rev + 1,
          updatedAt: Date.now(),
        };
        const changed = await this.sql.run(`
          UPDATE objects
          SET vault_name = ?, path_cipher = ?, path_mac = ?, mtime = ?, updated_at = ?, rev = ?
          WHERE account_id = ? AND file_id = ? AND rev = ?
        `, [
          moved.vaultName,
          moved.pathCipher,
          moved.pathMac,
          moved.mtime,
          moved.updatedAt,
          moved.rev,
          moved.accountId,
          moved.fileId,
          parentRev,
        ]);
        if (changed === 0) {
          const current = await this.findObject(row.accountId, row.fileId);
          await this.sql.exec("COMMIT");
          return { status: "conflict", reason: current ? "parent_rev" : "deleted", current: current ?? null };
        }
        await this.appendChange(moved, "upsert");
        const droppedVersionIds = recordVersion ? await recordVersion(moved) : [];
        await this.sql.exec("COMMIT");
        return { status: "updated", row: moved, droppedVersionIds };
      }
      if (!existing) {
        if (parentRev !== null) {
          await this.sql.exec("COMMIT");
          return { status: "conflict", reason: "deleted", current: null };
        }
        const created: ObjectRow = { ...row, rev: 1, updatedAt: Date.now() };
        await this.insertObject(created);
        await this.appendChange(created, "upsert");
        await writeBlob();
        const droppedVersionIds = recordVersion ? await recordVersion(created) : [];
        await this.sql.exec("COMMIT");
        return { status: "created", row: created, droppedVersionIds };
      }
      if (parentRev === null || parentRev !== existing.rev) {
        await this.sql.exec("COMMIT");
        return { status: "conflict", reason: "parent_rev", current: existing };
      }
      const updated: ObjectRow = { ...row, rev: existing.rev + 1, updatedAt: Date.now() };
      const changed = await this.sql.run(`
        UPDATE objects
        SET vault_name = ?, path_cipher = ?, path_mac = ?, content_mac = ?, size = ?, mtime = ?, updated_at = ?, encoding = ?, rev = ?
        WHERE account_id = ? AND file_id = ? AND rev = ?
      `, [
        updated.vaultName,
        updated.pathCipher,
        updated.pathMac,
        updated.contentMac,
        updated.size,
        updated.mtime,
        updated.updatedAt,
        updated.encoding,
        updated.rev,
        updated.accountId,
        updated.fileId,
        parentRev,
      ]);
      if (changed === 0) {
        const current = await this.findObject(row.accountId, row.fileId);
        await this.sql.exec("COMMIT");
        return { status: "conflict", reason: current ? "parent_rev" : "deleted", current: current ?? null };
      }
      await this.appendChange(updated, "upsert");
      await writeBlob();
      const droppedVersionIds = recordVersion ? await recordVersion(updated) : [];
      await this.sql.exec("COMMIT");
      return { status: "updated", row: updated, droppedVersionIds };
    } catch (error) {
      try {
        await this.sql.exec("ROLLBACK");
      } catch {
        // The transaction may already be closed.
      }
      if (isUniqueError(error)) {
        const current = await this.findObject(row.accountId, row.fileId);
        if (current) return { status: "conflict", reason: "parent_rev", current };
      }
      throw error;
    }
  }

  private async insertObject(row: ObjectRow): Promise<void> {
    await this.sql.run(`
      INSERT INTO objects (account_id, file_id, vault_name, path_cipher, content_mac, size, mtime, updated_at, encoding, rev, path_mac)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [row.accountId, row.fileId, row.vaultName, row.pathCipher, row.contentMac, row.size, row.mtime, row.updatedAt, row.encoding, row.rev, row.pathMac]);
  }

  async deleteObjects(accountId: string, fileIds: string[], vaultName: string): Promise<string[]> {
    const removed: string[] = [];
    await this.sql.exec("BEGIN");
    try {
      for (const fileId of fileIds) {
        const row = await this.findObject(accountId, fileId);
        if (!row || row.vaultName !== vaultName) continue;
        await this.moveToTrash(row);
        await this.appendChange(row, "delete");
        await this.sql.run("DELETE FROM objects WHERE account_id = ? AND file_id = ?", [accountId, fileId]);
        removed.push(fileId);
      }
      await this.sql.exec("COMMIT");
    } catch (error) {
      await this.sql.exec("ROLLBACK");
      throw error;
    }
    return removed;
  }

  async deleteUnnamed(accountId: string): Promise<string[]> {
    const rows = await this.listObjects(accountId, "");
    const removed: string[] = [];
    await this.sql.exec("BEGIN");
    try {
      for (const row of rows) {
        await this.moveToTrash(row);
        await this.appendChange(row, "delete");
        await this.sql.run("DELETE FROM objects WHERE account_id = ? AND file_id = ?", [accountId, row.fileId]);
        removed.push(row.fileId);
      }
      await this.sql.exec("COMMIT");
    } catch (error) {
      await this.sql.exec("ROLLBACK");
      throw error;
    }
    return removed;
  }

  async saveOauthState(state: string, nonce: string, codeVerifier: string, deviceCode: string, expiresAt: number): Promise<void> {
    await this.sql.run("DELETE FROM oauth_states WHERE expires_at <= ?", [Date.now()]);
    await this.sql.run(
      "INSERT INTO oauth_states (state, nonce, code_verifier, device_code, expires_at) VALUES (?, ?, ?, ?, ?)",
      [state, nonce, codeVerifier, deviceCode, expiresAt],
    );
  }

  async takeOauthState(state: string): Promise<{ nonce: string; codeVerifier: string; deviceCode: string } | undefined> {
    const row = await this.sql.get<{ nonce: string; code_verifier: string; device_code: string; expires_at: number | string }>(
      "SELECT nonce, code_verifier, device_code, expires_at FROM oauth_states WHERE state = ?",
      [state],
    );
    if (!row) return undefined;
    await this.sql.run("DELETE FROM oauth_states WHERE state = ?", [state]);
    if (Number(row.expires_at) <= Date.now()) return undefined;
    return { nonce: row.nonce, codeVerifier: row.code_verifier, deviceCode: row.device_code };
  }

  async putBlob(accountId: string, fileId: string, content: string): Promise<void> {
    const existing = await this.sql.get<{ file_id: string }>(
      "SELECT file_id FROM blobs WHERE account_id = ? AND file_id = ?",
      [accountId, fileId],
    );
    if (existing) {
      await this.sql.run("UPDATE blobs SET content = ? WHERE account_id = ? AND file_id = ?", [content, accountId, fileId]);
      return;
    }
    await this.sql.run("INSERT INTO blobs (account_id, file_id, content) VALUES (?, ?, ?)", [accountId, fileId, content]);
  }

  async listBlobs(): Promise<{ accountId: string; fileId: string; content: string }[]> {
    const rows = await this.sql.all<{ account_id: string; file_id: string; content: string | Buffer }>(
      "SELECT account_id, file_id, content FROM blobs",
    );
    return rows.map((row) => ({
      accountId: row.account_id,
      fileId: row.file_id,
      content: typeof row.content === "string" ? row.content : Buffer.from(row.content).toString("utf8"),
    }));
  }

  async getBlob(accountId: string, fileId: string): Promise<string | undefined> {
    const row = await this.sql.get<{ content: string | Buffer }>(
      "SELECT content FROM blobs WHERE account_id = ? AND file_id = ?",
      [accountId, fileId],
    );
    if (!row) return undefined;
    return typeof row.content === "string" ? row.content : Buffer.from(row.content).toString("utf8");
  }

  async deleteVault(accountId: string, vaultId: string): Promise<{ fileIds: string[]; versionIds: string[] } | undefined> {
    const vault = await this.findVaultById(accountId, vaultId);
    if (!vault) return undefined;
    const files = await this.listObjects(accountId, vault.name);
    const trashed = await this.sql.all<{ file_id: string }>(
      "SELECT file_id FROM trash WHERE account_id = ? AND vault_name = ?",
      [accountId, vault.name],
    );
    const versionRows = await this.sql.all<{ version_id: string; file_id: string }>(
      "SELECT version_id, file_id FROM file_versions WHERE account_id = ? AND vault_name = ?",
      [accountId, vault.name],
    );
    const versionIds = versionRows.map((row) => row.version_id);
    const retentionIds = new Set<string>([
      ...files.map((file) => file.fileId),
      ...trashed.map((row) => row.file_id),
      ...versionRows.map((row) => row.file_id),
    ]);
    await this.sql.exec("BEGIN");
    try {
      for (const fileId of retentionIds) {
        await this.sql.run("DELETE FROM file_retention WHERE account_id = ? AND file_id = ?", [accountId, fileId]);
      }
      await this.sql.run("DELETE FROM file_versions WHERE account_id = ? AND vault_name = ?", [accountId, vault.name]);
      await this.sql.run("DELETE FROM objects WHERE account_id = ? AND vault_name = ?", [accountId, vault.name]);
      await this.sql.run("DELETE FROM changes WHERE account_id = ? AND vault_name = ?", [accountId, vault.name]);
      await this.sql.run("DELETE FROM vault_cursors WHERE account_id = ? AND vault_name = ?", [accountId, vault.name]);
      await this.sql.run("DELETE FROM vault_policies WHERE account_id = ? AND vault_id = ?", [accountId, vaultId]);
      await this.sql.run("DELETE FROM trash WHERE account_id = ? AND vault_name = ?", [accountId, vault.name]);
      await this.sql.exec("COMMIT");
    } catch (error) {
      await this.sql.exec("ROLLBACK");
      throw error;
    }
    return {
      fileIds: [...files.map((file) => file.fileId), ...trashed.map((row) => row.file_id)],
      versionIds,
    };
  }

  async deleteBlob(accountId: string, fileId: string): Promise<void> {
    await this.sql.run("DELETE FROM blobs WHERE account_id = ? AND file_id = ?", [accountId, fileId]);
  }

  async putVersionBlob(accountId: string, versionId: string, content: string): Promise<void> {
    const existing = await this.sql.get<{ version_id: string }>(
      "SELECT version_id FROM version_blobs WHERE account_id = ? AND version_id = ?",
      [accountId, versionId],
    );
    if (existing) {
      await this.sql.run(
        "UPDATE version_blobs SET content = ? WHERE account_id = ? AND version_id = ?",
        [content, accountId, versionId],
      );
      return;
    }
    await this.sql.run(
      "INSERT INTO version_blobs (account_id, version_id, content) VALUES (?, ?, ?)",
      [accountId, versionId, content],
    );
  }

  async getVersionBlob(accountId: string, versionId: string): Promise<string | undefined> {
    const row = await this.sql.get<{ content: string | Buffer }>(
      "SELECT content FROM version_blobs WHERE account_id = ? AND version_id = ?",
      [accountId, versionId],
    );
    if (!row) return undefined;
    return typeof row.content === "string" ? row.content : Buffer.from(row.content).toString("utf8");
  }

  async deleteVersionBlob(accountId: string, versionId: string): Promise<void> {
    await this.sql.run("DELETE FROM version_blobs WHERE account_id = ? AND version_id = ?", [accountId, versionId]);
  }

  async getRetention(accountId: string, fileId: string): Promise<RetentionRow | undefined> {
    const row = await this.sql.get<{ auto_limit: number | string; manual_limit: number | string | null }>(
      "SELECT auto_limit, manual_limit FROM file_retention WHERE account_id = ? AND file_id = ?",
      [accountId, fileId],
    );
    if (!row) return undefined;
    const manual = row.manual_limit === null || row.manual_limit === undefined ? null : Number(row.manual_limit);
    return {
      autoLimit: Number(row.auto_limit),
      manualLimit: manual !== null && Number.isFinite(manual) ? manual : null,
    };
  }

  async saveRetention(
    accountId: string,
    fileId: string,
    autoLimit: number,
    manualLimit: number | null | undefined,
  ): Promise<RetentionRow> {
    const existing = await this.getRetention(accountId, fileId);
    const manual = manualLimit === undefined ? (existing?.manualLimit ?? null) : manualLimit;
    if (!existing) {
      await this.sql.run(
        "INSERT INTO file_retention (account_id, file_id, auto_limit, manual_limit) VALUES (?, ?, ?, ?)",
        [accountId, fileId, autoLimit, manual],
      );
    } else {
      await this.sql.run(
        "UPDATE file_retention SET auto_limit = ?, manual_limit = ? WHERE account_id = ? AND file_id = ?",
        [autoLimit, manual, accountId, fileId],
      );
    }
    return { autoLimit, manualLimit: manual };
  }

  async insertFileVersion(row: FileVersionRow): Promise<FileVersionRow> {
    const createdAt = await this.nextVersionTime(row.accountId, row.fileId, row.createdAt);
    const stored = { ...row, createdAt };
    await this.sql.run(`
      INSERT INTO file_versions (
        account_id, version_id, file_id, vault_name, path_cipher, content_mac,
        size, mtime, created_at, encoding, tip_rev, sync_trigger
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      stored.accountId,
      stored.versionId,
      stored.fileId,
      stored.vaultName,
      stored.pathCipher,
      stored.contentMac,
      stored.size,
      stored.mtime,
      stored.createdAt,
      stored.encoding,
      stored.tipRev,
      stored.syncTrigger,
    ]);
    return stored;
  }

  async findFileVersion(accountId: string, versionId: string): Promise<FileVersionRow | undefined> {
    const row = await this.sql.get<VersionSqlRow>(`
      SELECT ${VERSION_COLUMNS}
      FROM file_versions WHERE account_id = ? AND version_id = ?
    `, [accountId, versionId]);
    return row ? mapVersion(row) : undefined;
  }

  async listFileVersions(accountId: string, fileId: string, vaultName: string, limit: number): Promise<FileVersionRow[]> {
    const rows = await this.sql.all<VersionSqlRow>(`
      SELECT ${VERSION_COLUMNS}
      FROM file_versions
      WHERE account_id = ? AND file_id = ? AND vault_name = ?
      ORDER BY created_at DESC, version_id DESC
      LIMIT ?
    `, [accountId, fileId, vaultName, limit]);
    return rows.map(mapVersion);
  }

  async dropExcessAutoVersions(accountId: string, fileId: string, autoLimit: number): Promise<string[]> {
    const rows = await this.sql.all<{ version_id: string; created_at: number | string; sync_trigger: string }>(`
      SELECT version_id, created_at, sync_trigger
      FROM file_versions WHERE account_id = ? AND file_id = ?
    `, [accountId, fileId]);
    const drop = autoVersionsToDrop(rows.map((row) => ({
      versionId: row.version_id,
      createdAt: Number(row.created_at),
      syncTrigger: syncTriggerOf(row.sync_trigger),
    })), autoLimit);
    for (const versionId of drop) {
      await this.sql.run(
        "DELETE FROM file_versions WHERE account_id = ? AND version_id = ?",
        [accountId, versionId],
      );
    }
    return drop;
  }

  async deletePlaintextVersions(accountId: string, vaultName: string): Promise<string[]> {
    const rows = await this.sql.all<{ version_id: string }>(`
      SELECT version_id FROM file_versions
      WHERE account_id = ? AND vault_name = ? AND encoding = 'plain'
    `, [accountId, vaultName]);
    const ids = rows.map((row) => row.version_id);
    await this.sql.exec("BEGIN");
    try {
      for (const versionId of ids) {
        await this.sql.run(
          "DELETE FROM file_versions WHERE account_id = ? AND version_id = ?",
          [accountId, versionId],
        );
      }
      await this.sql.exec("COMMIT");
    } catch (error) {
      await this.sql.exec("ROLLBACK");
      throw error;
    }
    return ids;
  }

  private async nextVersionTime(accountId: string, fileId: string, candidate: number): Promise<number> {
    const row = await this.sql.get<{ max_at: number | string | null }>(
      "SELECT MAX(created_at) AS max_at FROM file_versions WHERE account_id = ? AND file_id = ?",
      [accountId, fileId],
    );
    const max = Number(row?.max_at ?? 0);
    const base = Number.isFinite(candidate) ? candidate : Date.now();
    return Math.max(base, max + 1);
  }

  async putUploadGrant(accountId: string, fileId: string, bytes: number, kind: "server" | "r2", expiresAt: number, sha256 = ""): Promise<void> {
    const existing = await this.sql.get<{ file_id: string }>(
      "SELECT file_id FROM upload_grants WHERE account_id = ? AND file_id = ?",
      [accountId, fileId],
    );
    if (existing) {
      await this.sql.run(
        "UPDATE upload_grants SET bytes = ?, kind = ?, expires_at = ?, sha256 = ? WHERE account_id = ? AND file_id = ?",
        [bytes, kind, expiresAt, sha256, accountId, fileId],
      );
      return;
    }
    await this.sql.run(
      "INSERT INTO upload_grants (account_id, file_id, bytes, kind, expires_at, sha256) VALUES (?, ?, ?, ?, ?, ?)",
      [accountId, fileId, bytes, kind, expiresAt, sha256],
    );
  }

  async getUploadGrant(accountId: string, fileId: string): Promise<{ bytes: number; kind: "server" | "r2"; expiresAt: number; sha256: string } | undefined> {
    const row = await this.sql.get<{ bytes: number | string; kind: string; expires_at: number | string; sha256: string | null }>(
      "SELECT bytes, kind, expires_at, sha256 FROM upload_grants WHERE account_id = ? AND file_id = ?",
      [accountId, fileId],
    );
    if (!row || (row.kind !== "server" && row.kind !== "r2")) return undefined;
    return { bytes: Number(row.bytes), kind: row.kind, expiresAt: Number(row.expires_at), sha256: row.sha256 ?? "" };
  }

  async deleteUploadGrant(accountId: string, fileId: string): Promise<void> {
    await this.sql.run("DELETE FROM upload_grants WHERE account_id = ? AND file_id = ?", [accountId, fileId]);
  }

  async putUploadBody(accountId: string, fileId: string, content: string): Promise<void> {
    const existing = await this.sql.get<{ file_id: string }>(
      "SELECT file_id FROM upload_bodies WHERE account_id = ? AND file_id = ?",
      [accountId, fileId],
    );
    if (existing) {
      await this.sql.run(
        "UPDATE upload_bodies SET content = ? WHERE account_id = ? AND file_id = ?",
        [content, accountId, fileId],
      );
      return;
    }
    await this.sql.run(
      "INSERT INTO upload_bodies (account_id, file_id, content) VALUES (?, ?, ?)",
      [accountId, fileId, content],
    );
  }

  async getUploadBody(accountId: string, fileId: string): Promise<string | undefined> {
    const row = await this.sql.get<{ content: string | Buffer }>(
      "SELECT content FROM upload_bodies WHERE account_id = ? AND file_id = ?",
      [accountId, fileId],
    );
    if (!row) return undefined;
    return typeof row.content === "string" ? row.content : Buffer.from(row.content).toString("utf8");
  }

  async deleteUploadBody(accountId: string, fileId: string): Promise<void> {
    await this.sql.run("DELETE FROM upload_bodies WHERE account_id = ? AND file_id = ?", [accountId, fileId]);
  }

  private async appendChange(row: ObjectRow, op: "upsert" | "delete"): Promise<void> {
    const seq = await this.bumpCursor(row.accountId, row.vaultName);
    await this.sql.run(`
      INSERT INTO changes (
        account_id, vault_name, seq, op, file_id, rev, content_mac, size, mtime, updated_at, encoding
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.accountId,
      row.vaultName,
      seq,
      op,
      row.fileId,
      row.rev,
      row.contentMac,
      row.size,
      row.mtime,
      row.updatedAt,
      row.encoding,
    ]);
  }

  private async bumpCursor(accountId: string, vaultName: string): Promise<number> {
    if (this.sql.dialect === "mysql") {
      await this.sql.run(`
        INSERT INTO vault_cursors (account_id, vault_name, seq) VALUES (?, ?, 1)
        ON DUPLICATE KEY UPDATE seq = seq + 1
      `, [accountId, vaultName]);
    } else {
      await this.sql.run(`
        INSERT INTO vault_cursors (account_id, vault_name, seq) VALUES (?, ?, 1)
        ON CONFLICT(account_id, vault_name) DO UPDATE SET seq = vault_cursors.seq + 1
      `, [accountId, vaultName]);
    }
    const row = await this.sql.get<{ seq: number | string }>(
      "SELECT seq FROM vault_cursors WHERE account_id = ? AND vault_name = ?",
      [accountId, vaultName],
    );
    return Number(row?.seq ?? 1);
  }

  private async moveToTrash(row: ObjectRow): Promise<void> {
    const hash = await this.getObjectHash(row.accountId, row.fileId);
    await this.sql.run("DELETE FROM trash WHERE account_id = ? AND file_id = ?", [row.accountId, row.fileId]);
    await this.sql.run(`
      INSERT INTO trash (account_id, file_id, vault_name, path_cipher, content_mac, size, mtime, encoding, rev, sha256, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [row.accountId, row.fileId, row.vaultName, row.pathCipher, row.contentMac, row.size, row.mtime, row.encoding, row.rev, hash, Date.now()]);
  }

  async listTrash(accountId: string, vaultName: string): Promise<{ fileId: string; pathCipher: string; size: number; deletedAt: number; rev: number }[]> {
    const rows = await this.sql.all<{ file_id: string; path_cipher: string; size: number | string; deleted_at: number | string; rev: number | string }>(
      "SELECT file_id, path_cipher, size, deleted_at, rev FROM trash WHERE account_id = ? AND vault_name = ? ORDER BY deleted_at DESC",
      [accountId, vaultName],
    );
    return rows.map((row) => ({
      fileId: row.file_id,
      pathCipher: row.path_cipher,
      size: Number(row.size),
      deletedAt: Number(row.deleted_at),
      rev: Number(row.rev),
    }));
  }

  async restoreTrash(accountId: string, fileId: string, vaultName: string): Promise<ObjectRow | undefined> {
    const row = await this.sql.get<{
      vault_name: string;
      path_cipher: string;
      content_mac: string;
      size: number | string;
      mtime: number | string;
      encoding: string;
      rev: number | string;
      sha256: string | null;
    }>(
      "SELECT vault_name, path_cipher, content_mac, size, mtime, encoding, rev, sha256 FROM trash WHERE account_id = ? AND file_id = ?",
      [accountId, fileId],
    );
    if (!row || row.vault_name !== vaultName) return undefined;
    if (await this.findObject(accountId, fileId)) return undefined;
    const restored: ObjectRow = {
      accountId,
      fileId,
      vaultName,
      pathCipher: row.path_cipher,
      contentMac: row.content_mac,
      size: Number(row.size),
      mtime: Number(row.mtime),
      updatedAt: Date.now(),
      encoding: row.encoding === "plain" ? "plain" : "e2ee",
      rev: Number(row.rev) + 1,
      pathMac: "",
    };
    await this.sql.exec("BEGIN");
    try {
      await this.insertObject(restored);
      await this.appendChange(restored, "upsert");
      await this.sql.run("DELETE FROM trash WHERE account_id = ? AND file_id = ?", [accountId, fileId]);
      if (row.sha256) await this.setObjectHash(accountId, fileId, row.sha256);
      await this.sql.exec("COMMIT");
    } catch (error) {
      await this.sql.exec("ROLLBACK");
      throw error;
    }
    return restored;
  }

  async purgeTrash(accountId: string, olderThan: number, maxFiles: number): Promise<string[]> {
    const removed: string[] = [];
    const aged = await this.sql.all<{ file_id: string }>(
      "SELECT file_id FROM trash WHERE account_id = ? AND deleted_at < ?",
      [accountId, olderThan],
    );
    for (const row of aged) {
      await this.sql.run("DELETE FROM trash WHERE account_id = ? AND file_id = ?", [accountId, row.file_id]);
      removed.push(row.file_id);
    }
    if (maxFiles > 0) {
      const extra = await this.sql.all<{ file_id: string }>(
        "SELECT file_id FROM trash WHERE account_id = ? ORDER BY deleted_at DESC",
        [accountId],
      );
      for (const row of extra.slice(maxFiles)) {
        await this.sql.run("DELETE FROM trash WHERE account_id = ? AND file_id = ?", [accountId, row.file_id]);
        removed.push(row.file_id);
      }
    }
    return removed;
  }

  async vaultLimits(accountId: string, vaultName: string): Promise<{ maxFiles: number; maxBytes: number }> {
    const row = await this.sql.get<{ max_files: number | string | null; max_bytes: number | string | null }>(
      "SELECT max_files, max_bytes FROM vault_policies WHERE account_id = ? AND vault_name = ?",
      [accountId, vaultName],
    );
    return { maxFiles: Number(row?.max_files ?? 0), maxBytes: Number(row?.max_bytes ?? 0) };
  }

  async setVaultLimits(accountId: string, vaultId: string, maxFiles: number, maxBytes: number): Promise<boolean> {
    const vault = await this.findVaultById(accountId, vaultId);
    if (!vault) return false;
    await this.sql.run(
      "UPDATE vault_policies SET max_files = ?, max_bytes = ? WHERE account_id = ? AND vault_name = ?",
      [maxFiles, maxBytes, accountId, vault.name],
    );
    return true;
  }

  async vaultRoom(accountId: string, vaultName: string, fileId: string, nextSize: number): Promise<string | null> {
    const limits = await this.vaultLimits(accountId, vaultName);
    if (limits.maxFiles <= 0 && limits.maxBytes <= 0) return null;
    const usage = await this.sql.get<{ files: number | string; bytes: number | string | null }>(
      "SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM objects WHERE account_id = ? AND vault_name = ?",
      [accountId, vaultName],
    );
    const existing = await this.findObject(accountId, fileId);
    const sameVault = existing?.vaultName === vaultName;
    const files = Number(usage?.files ?? 0) + (sameVault ? 0 : 1);
    const bytes = Number(usage?.bytes ?? 0) - (sameVault ? existing.size : 0) + nextSize;
    if (limits.maxFiles > 0 && files > limits.maxFiles) return "This vault has reached its file limit";
    if (limits.maxBytes > 0 && bytes > limits.maxBytes) return "This vault has reached its size limit";
    return null;
  }

  async accountPolicy(accountId: string): Promise<{ trashDays: number; trashMaxFiles: number }> {
    const row = await this.sql.get<{ trash_days: number | string; trash_max_files: number | string }>(
      "SELECT trash_days, trash_max_files FROM account_policies WHERE account_id = ?",
      [accountId],
    );
    if (!row) return { trashDays: 30, trashMaxFiles: 200 };
    return { trashDays: Number(row.trash_days), trashMaxFiles: Number(row.trash_max_files) };
  }

  async setAccountPolicy(accountId: string, trashDays: number, trashMaxFiles: number): Promise<void> {
    const existing = await this.sql.get<{ account_id: string }>(
      "SELECT account_id FROM account_policies WHERE account_id = ?",
      [accountId],
    );
    if (existing) {
      await this.sql.run(
        "UPDATE account_policies SET trash_days = ?, trash_max_files = ? WHERE account_id = ?",
        [trashDays, trashMaxFiles, accountId],
      );
      return;
    }
    await this.sql.run(
      "INSERT INTO account_policies (account_id, trash_days, trash_max_files) VALUES (?, ?, ?)",
      [accountId, trashDays, trashMaxFiles],
    );
  }

  async listAccountIds(): Promise<string[]> {
    const rows = await this.sql.all<{ id: string }>("SELECT id FROM accounts");
    return rows.map((row) => row.id);
  }

  async listExpiredGrants(now: number): Promise<{ accountId: string; fileId: string }[]> {
    const rows = await this.sql.all<{ account_id: string; file_id: string }>(
      "SELECT account_id, file_id FROM upload_grants WHERE expires_at <= ?",
      [now],
    );
    return rows.map((row) => ({ accountId: row.account_id, fileId: row.file_id }));
  }

  async setObjectHash(accountId: string, fileId: string, sha256: string): Promise<void> {
    const existing = await this.sql.get<{ file_id: string }>(
      "SELECT file_id FROM object_hashes WHERE account_id = ? AND file_id = ?",
      [accountId, fileId],
    );
    if (existing) {
      await this.sql.run("UPDATE object_hashes SET sha256 = ? WHERE account_id = ? AND file_id = ?", [sha256, accountId, fileId]);
      return;
    }
    await this.sql.run("INSERT INTO object_hashes (account_id, file_id, sha256) VALUES (?, ?, ?)", [accountId, fileId, sha256]);
  }

  async getObjectHash(accountId: string, fileId: string): Promise<string> {
    const row = await this.sql.get<{ sha256: string }>(
      "SELECT sha256 FROM object_hashes WHERE account_id = ? AND file_id = ?",
      [accountId, fileId],
    );
    return row?.sha256 ?? "";
  }

  async deleteObjectHash(accountId: string, fileId: string): Promise<void> {
    await this.sql.run("DELETE FROM object_hashes WHERE account_id = ? AND file_id = ?", [accountId, fileId]);
  }

  async countLogins(): Promise<number> {
    const row = await this.sql.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM login_ids");
    return Number(row?.n ?? 0);
  }

  async countAccounts(): Promise<number> {
    const row = await this.sql.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM accounts");
    return Number(row?.n ?? 0);
  }

  async insertLogin(loginId: string, accountId: string, passwordHash: string, passwordSalt: string): Promise<void> {
    await this.sql.run(
      "INSERT INTO login_ids (login_id, account_id, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
      [loginId, accountId, passwordHash, passwordSalt, Date.now()],
    );
  }

  async findLogin(loginId: string): Promise<{ loginId: string; accountId: string; passwordHash: string; passwordSalt: string } | undefined> {
    const row = await this.sql.get<{ login_id: string; account_id: string; password_hash: string; password_salt: string }>(
      "SELECT login_id, account_id, password_hash, password_salt FROM login_ids WHERE login_id = ?",
      [loginId],
    );
    if (!row) return undefined;
    return { loginId: row.login_id, accountId: row.account_id, passwordHash: row.password_hash, passwordSalt: row.password_salt };
  }

  async findLoginByAccount(accountId: string): Promise<{ loginId: string; accountId: string } | undefined> {
    const row = await this.sql.get<{ login_id: string; account_id: string }>(
      "SELECT login_id, account_id FROM login_ids WHERE account_id = ?",
      [accountId],
    );
    if (!row) return undefined;
    return { loginId: row.login_id, accountId: row.account_id };
  }

  async updateLoginPassword(loginId: string, passwordHash: string, passwordSalt: string): Promise<void> {
    await this.sql.run(
      "UPDATE login_ids SET password_hash = ?, password_salt = ? WHERE login_id = ?",
      [passwordHash, passwordSalt, loginId],
    );
  }

  async deleteLogin(loginId: string): Promise<void> {
    await this.sql.run("DELETE FROM login_ids WHERE login_id = ?", [loginId]);
  }

  async setDisplayName(accountId: string, displayName: string): Promise<void> {
    await this.sql.run("UPDATE accounts SET display_name = ? WHERE id = ?", [displayName, accountId]);
  }

  async listLogins(): Promise<{ loginId: string; accountId: string; displayName: string }[]> {
    const rows = await this.sql.all<{ login_id: string; account_id: string; display_name: string | null }>(`
      SELECT login_ids.login_id, login_ids.account_id, accounts.display_name
      FROM login_ids LEFT JOIN accounts ON accounts.id = login_ids.account_id
      ORDER BY login_ids.login_id
    `);
    return rows.map((row) => ({ loginId: row.login_id, accountId: row.account_id, displayName: row.display_name ?? "" }));
  }

  async listAccounts(): Promise<Account[]> {
    const rows = await this.sql.all<AccountRow>("SELECT id, subject, display_name, created_at FROM accounts ORDER BY created_at");
    return rows.map((row) => mapAccount(row)).filter((row): row is Account => Boolean(row));
  }
}

export async function openDatabase(config: AppConfig): Promise<SyncDb> {
  const database = config.database.kind === "sqlite"
    ? await openSqlite(config.database.path)
    : config.database.kind === "postgres"
      ? await openPostgres(config.database.url)
      : await openMysql(config.database.url);
  const db = new SyncDb(database);
  for (const statement of schema(database.dialect)) {
    await database.exec(statement);
  }
  try {
    await database.exec("ALTER TABLE objects ADD COLUMN encoding VARCHAR(16) NOT NULL DEFAULT 'e2ee'");
  } catch {
    // New databases already have this column.
  }
  try {
    await database.exec("ALTER TABLE objects ADD COLUMN vault_name VARCHAR(200) NOT NULL DEFAULT ''");
  } catch {
    // New databases already have this column.
  }
  try {
    await database.exec("ALTER TABLE vault_policies ADD COLUMN vault_id VARCHAR(64) NOT NULL DEFAULT ''");
  } catch {
    // New databases already have this column.
  }
  try {
    await database.exec("ALTER TABLE objects ADD COLUMN rev BIGINT NOT NULL DEFAULT 1");
  } catch {
    // New databases already have this column. Existing rows keep revision 1.
  }
  for (const statement of [
    "ALTER TABLE objects ADD COLUMN path_mac VARCHAR(64) NOT NULL DEFAULT ''",
    "ALTER TABLE api_tokens ADD COLUMN expires_at BIGINT NOT NULL DEFAULT 0",
    "ALTER TABLE vault_policies ADD COLUMN max_files BIGINT NOT NULL DEFAULT 0",
    "ALTER TABLE vault_policies ADD COLUMN max_bytes BIGINT NOT NULL DEFAULT 0",
    "ALTER TABLE upload_grants ADD COLUMN sha256 VARCHAR(64) NOT NULL DEFAULT ''",
  ]) {
    try {
      await database.exec(statement);
    } catch {
      // The column is already present.
    }
  }
  await database.run(
    "UPDATE api_tokens SET expires_at = ? WHERE expires_at IS NULL OR expires_at = 0",
    [Date.now() + config.sessionTtlMs],
  );
  const missing = await database.all<{ account_id: string; vault_name: string }>(
    "SELECT account_id, vault_name FROM vault_policies WHERE vault_id IS NULL OR vault_id = ''",
  );
  for (const row of missing) {
    await database.run(
      "UPDATE vault_policies SET vault_id = ? WHERE account_id = ? AND vault_name = ?",
      [crypto.randomUUID(), row.account_id, row.vault_name],
    );
  }
  return db;
}

function schema(dialect: Queryable["dialect"]): string[] {
  const large = dialect === "mysql" ? "LONGTEXT" : "TEXT";
  return [
    `CREATE TABLE IF NOT EXISTS accounts (
      id VARCHAR(64) PRIMARY KEY,
      subject VARCHAR(512) NOT NULL UNIQUE,
      display_name VARCHAR(512) NOT NULL,
      created_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS device_codes (
      code VARCHAR(128) PRIMARY KEY,
      account_id VARCHAR(64),
      expires_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS login_codes (
      code VARCHAR(128) PRIMARY KEY,
      account_id VARCHAR(64) NOT NULL,
      state VARCHAR(128) NOT NULL,
      expires_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS pairing_codes (
      code VARCHAR(32) PRIMARY KEY,
      account_id VARCHAR(64) NOT NULL,
      expires_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS credentials (
      account_id VARCHAR(64) PRIMARY KEY,
      auth_key VARCHAR(256) NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS api_tokens (
      token_hash VARCHAR(64) PRIMARY KEY,
      account_id VARCHAR(64) NOT NULL,
      created_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS vault_policies (
      account_id VARCHAR(64) NOT NULL,
      vault_name VARCHAR(200) NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0,
      vault_id VARCHAR(64) NOT NULL DEFAULT '',
      PRIMARY KEY (account_id, vault_name)
    )`,
    `CREATE TABLE IF NOT EXISTS objects (
      account_id VARCHAR(64) NOT NULL,
      file_id VARCHAR(64) NOT NULL,
      vault_name VARCHAR(200) NOT NULL DEFAULT '',
      path_cipher ${large} NOT NULL,
      content_mac VARCHAR(64) NOT NULL,
      size BIGINT NOT NULL,
      mtime BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      encoding VARCHAR(16) NOT NULL DEFAULT 'e2ee',
      rev BIGINT NOT NULL DEFAULT 1,
      PRIMARY KEY (account_id, file_id)
    )`,
    `CREATE TABLE IF NOT EXISTS vault_cursors (
      account_id VARCHAR(64) NOT NULL,
      vault_name VARCHAR(200) NOT NULL,
      seq BIGINT NOT NULL,
      PRIMARY KEY (account_id, vault_name)
    )`,
    `CREATE TABLE IF NOT EXISTS changes (
      account_id VARCHAR(64) NOT NULL,
      vault_name VARCHAR(200) NOT NULL,
      seq BIGINT NOT NULL,
      op VARCHAR(16) NOT NULL,
      file_id VARCHAR(64) NOT NULL,
      rev BIGINT NOT NULL DEFAULT 0,
      content_mac VARCHAR(64) NOT NULL DEFAULT '',
      size BIGINT NOT NULL DEFAULT 0,
      mtime BIGINT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL,
      encoding VARCHAR(16) NOT NULL DEFAULT 'e2ee',
      PRIMARY KEY (account_id, vault_name, seq)
    )`,
    `CREATE TABLE IF NOT EXISTS blobs (
      account_id VARCHAR(64) NOT NULL,
      file_id VARCHAR(64) NOT NULL,
      content ${large} NOT NULL,
      PRIMARY KEY (account_id, file_id)
    )`,
    `CREATE TABLE IF NOT EXISTS upload_grants (
      account_id VARCHAR(64) NOT NULL,
      file_id VARCHAR(64) NOT NULL,
      bytes BIGINT NOT NULL,
      kind VARCHAR(16) NOT NULL,
      expires_at BIGINT NOT NULL,
      PRIMARY KEY (account_id, file_id)
    )`,
    `CREATE TABLE IF NOT EXISTS upload_bodies (
      account_id VARCHAR(64) NOT NULL,
      file_id VARCHAR(64) NOT NULL,
      content ${large} NOT NULL,
      PRIMARY KEY (account_id, file_id)
    )`,
    `CREATE TABLE IF NOT EXISTS file_versions (
      account_id VARCHAR(64) NOT NULL,
      version_id VARCHAR(64) NOT NULL,
      file_id VARCHAR(64) NOT NULL,
      vault_name VARCHAR(200) NOT NULL DEFAULT '',
      path_cipher ${large} NOT NULL,
      content_mac VARCHAR(64) NOT NULL,
      size BIGINT NOT NULL,
      mtime BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      encoding VARCHAR(16) NOT NULL DEFAULT 'e2ee',
      tip_rev BIGINT NOT NULL,
      sync_trigger VARCHAR(16) NOT NULL,
      PRIMARY KEY (account_id, version_id)
    )`,
    `CREATE TABLE IF NOT EXISTS version_blobs (
      account_id VARCHAR(64) NOT NULL,
      version_id VARCHAR(64) NOT NULL,
      content ${large} NOT NULL,
      PRIMARY KEY (account_id, version_id)
    )`,
    `CREATE TABLE IF NOT EXISTS file_retention (
      account_id VARCHAR(64) NOT NULL,
      file_id VARCHAR(64) NOT NULL,
      auto_limit INTEGER NOT NULL,
      manual_limit INTEGER,
      PRIMARY KEY (account_id, file_id)
    )`,
    `CREATE TABLE IF NOT EXISTS oauth_states (
      state VARCHAR(128) PRIMARY KEY,
      nonce VARCHAR(128) NOT NULL,
      code_verifier VARCHAR(128) NOT NULL,
      device_code VARCHAR(128) NOT NULL,
      expires_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS login_ids (
      login_id VARCHAR(32) PRIMARY KEY,
      account_id VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(128) NOT NULL,
      password_salt VARCHAR(64) NOT NULL,
      created_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS account_policies (
      account_id VARCHAR(64) PRIMARY KEY,
      trash_days INTEGER NOT NULL DEFAULT 30,
      trash_max_files INTEGER NOT NULL DEFAULT 200
    )`,
    `CREATE TABLE IF NOT EXISTS trash (
      account_id VARCHAR(64) NOT NULL,
      file_id VARCHAR(64) NOT NULL,
      vault_name VARCHAR(200) NOT NULL,
      path_cipher ${large} NOT NULL,
      content_mac VARCHAR(64) NOT NULL,
      size BIGINT NOT NULL,
      mtime BIGINT NOT NULL,
      encoding VARCHAR(16) NOT NULL,
      rev BIGINT NOT NULL,
      sha256 VARCHAR(64) NOT NULL DEFAULT '',
      deleted_at BIGINT NOT NULL,
      PRIMARY KEY (account_id, file_id)
    )`,
    `CREATE TABLE IF NOT EXISTS object_hashes (
      account_id VARCHAR(64) NOT NULL,
      file_id VARCHAR(64) NOT NULL,
      sha256 VARCHAR(64) NOT NULL,
      PRIMARY KEY (account_id, file_id)
    )`,
  ];
}

function mapAccount(row: AccountRow | undefined): Account | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    subject: row.subject,
    displayName: row.display_name,
    createdAt: Number(row.created_at),
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mapObject(row: ObjectSqlRow): ObjectRow {
  const rev = Number(row.rev ?? 1);
  return {
    accountId: row.account_id,
    fileId: row.file_id,
    vaultName: row.vault_name ?? "",
    pathCipher: row.path_cipher,
    contentMac: row.content_mac,
    size: Number(row.size),
    mtime: Number(row.mtime),
    updatedAt: Number(row.updated_at),
    encoding: row.encoding === "plain" ? "plain" : "e2ee",
    rev: Number.isSafeInteger(rev) && rev > 0 ? rev : 1,
    pathMac: row.path_mac ?? "",
  };
}

function mapVersion(row: VersionSqlRow): FileVersionRow {
  const tipRev = Number(row.tip_rev ?? 0);
  return {
    accountId: row.account_id,
    versionId: row.version_id,
    fileId: row.file_id,
    vaultName: row.vault_name ?? "",
    pathCipher: row.path_cipher,
    contentMac: row.content_mac,
    size: Number(row.size),
    mtime: Number(row.mtime),
    createdAt: Number(row.created_at),
    encoding: row.encoding === "plain" ? "plain" : "e2ee",
    tipRev: Number.isSafeInteger(tipRev) && tipRev > 0 ? tipRev : 0,
    syncTrigger: syncTriggerOf(row.sync_trigger),
  };
}

function syncTriggerOf(value: string | null | undefined): SyncTrigger {
  if (value === "manual" || value === "restore" || value === "auto") return value;
  return "auto";
}

function mapChange(row: ChangeSqlRow): ChangeRow {
  const rev = Number(row.rev ?? 0);
  return {
    seq: Number(row.seq),
    op: row.op === "delete" ? "delete" : "upsert",
    fileId: row.file_id,
    rev: Number.isSafeInteger(rev) && rev > 0 ? rev : 0,
    contentMac: row.content_mac ?? "",
    size: Number(row.size ?? 0),
    mtime: Number(row.mtime ?? 0),
    updatedAt: Number(row.updated_at),
    encoding: row.encoding === "plain" ? "plain" : "e2ee",
  };
}

function isUniqueError(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "23505" || code === "1062" || code === "ER_DUP_ENTRY") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|duplicate key|duplicate entry|SQLITE_CONSTRAINT_UNIQUE/i.test(message);
}
