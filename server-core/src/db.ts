import { createHash } from "node:crypto";
import { bytesToBase64Url, randomBytes } from "../../shared/src/codec";
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

  async issueToken(accountId: string): Promise<string> {
    const token = bytesToBase64Url(randomBytes(32));
    await this.sql.run(
      "INSERT INTO api_tokens (token_hash, account_id, created_at) VALUES (?, ?, ?)",
      [hashToken(token), accountId, Date.now()],
    );
    return token;
  }

  async findAccountByToken(token: string): Promise<string | undefined> {
    if (!token || token.length > 200) return undefined;
    const row = await this.sql.get<{ account_id: string }>(
      "SELECT account_id FROM api_tokens WHERE token_hash = ?",
      [hashToken(token)],
    );
    return row?.account_id;
  }

  async revokeToken(token: string): Promise<void> {
    if (!token || token.length > 200) return;
    await this.sql.run("DELETE FROM api_tokens WHERE token_hash = ?", [hashToken(token)]);
  }

  async listObjects(accountId: string, vaultName: string): Promise<ObjectRow[]> {
    const rows = await this.sql.all<ObjectSqlRow>(`
      SELECT account_id, file_id, vault_name, path_cipher, content_mac, size, mtime, updated_at, encoding
      FROM objects WHERE account_id = ? AND vault_name = ? ORDER BY file_id
    `, [accountId, vaultName]);
    return rows.map(mapObject);
  }

  async findObject(accountId: string, fileId: string): Promise<ObjectRow | undefined> {
    const row = await this.sql.get<ObjectSqlRow>(`
      SELECT account_id, file_id, vault_name, path_cipher, content_mac, size, mtime, updated_at, encoding
      FROM objects WHERE account_id = ? AND file_id = ?
    `, [accountId, fileId]);
    return row ? mapObject(row) : undefined;
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

  async upsertObject(row: ObjectRow): Promise<void> {
    const existing = await this.findObject(row.accountId, row.fileId);
    if (existing) {
      await this.sql.run(`
        UPDATE objects
        SET vault_name = ?, path_cipher = ?, content_mac = ?, size = ?, mtime = ?, updated_at = ?, encoding = ?
        WHERE account_id = ? AND file_id = ?
      `, [row.vaultName, row.pathCipher, row.contentMac, row.size, row.mtime, row.updatedAt, row.encoding, row.accountId, row.fileId]);
      return;
    }
    await this.sql.run(`
      INSERT INTO objects (account_id, file_id, vault_name, path_cipher, content_mac, size, mtime, updated_at, encoding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [row.accountId, row.fileId, row.vaultName, row.pathCipher, row.contentMac, row.size, row.mtime, row.updatedAt, row.encoding]);
  }

  async deleteObjects(accountId: string, fileIds: string[], vaultName: string): Promise<string[]> {
    const removed: string[] = [];
    await this.sql.exec("BEGIN");
    try {
      for (const fileId of fileIds) {
        const row = await this.sql.get<{ file_id: string }>(
          "SELECT file_id FROM objects WHERE account_id = ? AND file_id = ? AND vault_name = ?",
          [accountId, fileId, vaultName],
        );
        if (!row) continue;
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
    const rows = await this.sql.all<{ file_id: string }>(
      "SELECT file_id FROM objects WHERE account_id = ? AND vault_name = ''",
      [accountId],
    );
    const removed = rows.map((row) => row.file_id);
    for (const fileId of removed) {
      await this.sql.run("DELETE FROM objects WHERE account_id = ? AND file_id = ?", [accountId, fileId]);
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

  async getBlob(accountId: string, fileId: string): Promise<string | undefined> {
    const row = await this.sql.get<{ content: string | Buffer }>(
      "SELECT content FROM blobs WHERE account_id = ? AND file_id = ?",
      [accountId, fileId],
    );
    if (!row) return undefined;
    return typeof row.content === "string" ? row.content : Buffer.from(row.content).toString("utf8");
  }

  async deleteBlob(accountId: string, fileId: string): Promise<void> {
    await this.sql.run("DELETE FROM blobs WHERE account_id = ? AND file_id = ?", [accountId, fileId]);
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
      PRIMARY KEY (account_id, file_id)
    )`,
    `CREATE TABLE IF NOT EXISTS blobs (
      account_id VARCHAR(64) NOT NULL,
      file_id VARCHAR(64) NOT NULL,
      content ${large} NOT NULL,
      PRIMARY KEY (account_id, file_id)
    )`,
    `CREATE TABLE IF NOT EXISTS oauth_states (
      state VARCHAR(128) PRIMARY KEY,
      nonce VARCHAR(128) NOT NULL,
      code_verifier VARCHAR(128) NOT NULL,
      device_code VARCHAR(128) NOT NULL,
      expires_at BIGINT NOT NULL
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
  };
}
