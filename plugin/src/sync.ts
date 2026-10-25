import { FileSystemAdapter, Modal, Notice, TFile, type App, type Vault } from "obsidian";
import { bytesToBase64, randomBytes } from "../../shared/src/codec";
import { contentMac, deriveKeys, fileIdForPath, openBytes, plainFileId, plainMac, sealBytes } from "../../shared/src/crypto";
import { MAX_FILE_BYTES, MIN_SECRET_LENGTH, remoteRev, type ChangeEntry, type Encoding, type PutResult, type RemoteFile, type VaultStat } from "../../shared/src/protocol";
import { decideSyncAction } from "../../shared/src/reconcile";
import { SyncClient, SyncConflictError, fetchBootstrap, openExternal, resolveSyncHost } from "./client";
import { askConflict, type ConflictChoice, type ConflictView } from "./conflict";
import { suffixSelected } from "./file-kinds";
import { t } from "./i18n";
import { isDesktopApp, obsidianConfigDir, warnMissingObsidianConfig } from "./obsidian-dir";
import type E2eeSyncPlugin from "./main";
import type { FileIndexEntry } from "./main";

export type RestoreMode = "overwrite" | "create";

const BLOCKED = new Set([".obsidian", ".git", ".trash", "node_modules"]);
const PLUGIN_FILES = new Set([
  ".obsidian/plugins/e2ee-sync/manifest.json",
  ".obsidian/plugins/e2ee-sync/main.js",
  ".obsidian/plugins/e2ee-sync/styles.css",
]);

export function isSyncablePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (PLUGIN_FILES.has(normalized)) return true;
  return normalized.split("/").every((part) => part && !BLOCKED.has(part));
}

export function propagatePlugin(plugin: E2eeSyncPlugin): string[] {
  if (!isDesktopApp()) return [];
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return [];
  const fs = nodeFs();
  const source = fs.resolve(adapter.getBasePath(), ".obsidian", "plugins", "e2ee-sync");
  if (!fs.existsSync(fs.resolve(source, "main.js"))) return [];
  const configDir = obsidianConfigDir();
  if (!configDir) {
    warnMissingObsidianConfig();
    return [];
  }
  let parsed: { vaults?: Record<string, { path?: string }> } = {};
  try {
    parsed = JSON.parse(fs.readText(fs.resolve(configDir, "obsidian.json"))) as typeof parsed;
  } catch (error) {
    console.warn("Could not read the Obsidian vault list", error);
    return [];
  }
  const current = fs.resolve(adapter.getBasePath());
  const installed: string[] = [];
  for (const vault of Object.values(parsed.vaults ?? {})) {
    if (!vault.path) continue;
    const dest = fs.resolve(vault.path);
    if (dest === current || !fs.existsSync(dest)) continue;
    const marker = fs.resolve(dest, ".obsidian", "plugins", "e2ee-sync", "main.js");
    const fresh = !fs.existsSync(marker);
    const sourceMtime = fs.statMtime(fs.resolve(source, "main.js"));
    if (fresh || sourceMtime > fs.statMtime(marker)) installPluginCopy(plugin, dest);
    else enablePlugin(fs, dest);
    if (fresh) installed.push(vault.path);
  }
  return installed;
}

export async function pushVault(plugin: E2eeSyncPlugin): Promise<string> {
  const ready = await openClient(plugin);
  const encoding: Encoding = plugin.settings.encryptNotes ? "e2ee" : "plain";
  if (encoding === "plain") {
    const boot = await fetchBootstrap(ready.host, plugin.settings.accessToken);
    if (boot.requireEncryption) throw new Error(t("serverEncrypt"));
  }
  const files = plugin.app.vault.getFiles().filter((file) => shouldSync(plugin, file.path));
  const loaded = await loadRemote(plugin, ready);
  const remote = loaded.remote;
  const seen = new Set<string>();
  const index = { ...plugin.settings.index };
  const conflicts: PendingConflict[] = [];
  let uploaded = 0;
  let downloaded = 0;
  let unchanged = 0;
  let removed = 0;
  let deferCursor = false;
  const skippedLarge: string[] = [];
  const remoteDeletes: string[] = [];
  const total = files.length + remote.size;
  const counts = () => uploaded + downloaded + unchanged + removed;

  for (const file of files) {
    const fileId = ready.keys
      ? await fileIdForPath(ready.keys.idKey, file.path, ready.vaultName)
      : await plainFileId(ready.vaultName, file.path);
    seen.add(fileId);
    const cached = index[fileId];
    const remoteFile = remote.get(fileId) ?? null;
    const plain = new Uint8Array(await plugin.app.vault.readBinary(file));
    const mac = await fingerprint(ready, plain);
    const action = decideSyncAction({
      local: { contentMac: mac, encoding },
      remote: remoteSide(remoteFile),
      base: baseOf(cached),
    });
    if (action.type === "unchanged") {
      index[fileId] = syncedEntry(file.path, file.stat.mtime, file.stat.size, mac, encoding, remoteRev(remoteFile ?? {}) || cached?.rev);
      unchanged++;
      continue;
    }
    if (action.type === "delete-local") {
      await plugin.app.vault.delete(file);
      delete index[fileId];
      removed++;
      plugin.setStatus(t("syncProgress", { done: counts(), total }));
      continue;
    }
    if (action.type === "download") {
      if (!remoteFile) continue;
      if (remoteFile.size > MAX_FILE_BYTES) {
        skippedLarge.push(file.path);
        deferCursor = true;
        continue;
      }
      if (await pullRemote(plugin, ready, remoteFile, index)) downloaded++;
      else unchanged++;
      plugin.setStatus(t("syncProgress", { done: counts(), total }));
      continue;
    }
    if (action.type === "upload") {
      if (plain.byteLength > MAX_FILE_BYTES) {
        skippedLarge.push(file.path);
        continue;
      }
      const outcome = await uploadTracked(plugin, ready, index, {
        fileId,
        path: file.path,
        plain,
        mac,
        encoding,
        mtime: file.stat.mtime,
        size: file.stat.size,
        parentRev: action.parentRev,
        base: cached ?? null,
        remote: remoteFile,
      });
      if (outcome === "uploaded") uploaded++;
      else conflicts.push(outcome);
      plugin.setStatus(t("syncProgress", { done: counts(), total }));
      continue;
    }
    if (action.type === "conflict") {
      if (plain.byteLength > MAX_FILE_BYTES || (remoteFile && remoteFile.size > MAX_FILE_BYTES)) {
        skippedLarge.push(file.path);
        deferCursor = true;
        continue;
      }
      conflicts.push(await pendingConflict(ready, {
        fileId,
        path: file.path,
        kind: action.kind === "local-deleted" ? "content" : action.kind,
        localBytes: plain,
        remote: remoteFile,
        base: cached ?? null,
        encoding,
      }));
      continue;
    }
  }

  for (const [fileId, cached] of Object.entries(index)) {
    if (seen.has(fileId) || !shouldSync(plugin, cached.path)) continue;
    if (plugin.app.vault.getAbstractFileByPath(cached.path) instanceof TFile) continue;
    const remoteFile = remote.get(fileId) ?? null;
    const action = decideSyncAction({
      local: null,
      remote: remoteSide(remoteFile),
      base: baseOf(cached),
    });
    if (action.type === "unchanged" || action.type === "delete-local") {
      delete index[fileId];
      continue;
    }
    if (action.type === "delete-remote") {
      remoteDeletes.push(fileId);
      seen.add(fileId);
      continue;
    }
    if (action.type === "download" && remoteFile) {
      seen.add(fileId);
      if (remoteFile.size > MAX_FILE_BYTES) {
        skippedLarge.push(cached.path);
        deferCursor = true;
        continue;
      }
      if (await pullRemote(plugin, ready, remoteFile, index)) downloaded++;
      else unchanged++;
      continue;
    }
    if (action.type === "conflict") {
      seen.add(fileId);
      if (remoteFile && remoteFile.size > MAX_FILE_BYTES) {
        skippedLarge.push(cached.path);
        deferCursor = true;
        continue;
      }
      conflicts.push(await pendingConflict(ready, {
        fileId,
        path: cached.path,
        kind: "local-deleted",
        localBytes: null,
        remote: remoteFile,
        base: cached,
        encoding,
      }));
    }
  }

  if (remoteDeletes.length > 0) {
    await ready.client.deleteObjects(ready.vaultName, remoteDeletes, files.length);
    for (const fileId of remoteDeletes) delete index[fileId];
    removed += remoteDeletes.length;
  }

  for (const remoteFile of remote.values()) {
    if (seen.has(remoteFile.fileId)) continue;
    if (remoteFile.size > MAX_FILE_BYTES) {
      skippedLarge.push(remoteFile.fileId);
      deferCursor = true;
      continue;
    }
    if (await pullRemote(plugin, ready, remoteFile, index)) downloaded++;
    plugin.setStatus(t("syncProgress", { done: counts(), total }));
  }

  const device = deviceLabel();
  let resolved = 0;
  let unresolved = 0;
  for (let i = 0; i < conflicts.length; i++) {
    const item = conflicts[i];
    if (!item) continue;
    plugin.setStatus(t("conflictTitle", { index: i + 1, total: conflicts.length }));
    const choice = await askConflict(plugin.app, conflictView(item, i + 1, conflicts.length));
    const outcome = await applyConflict(plugin, ready, index, item, choice, device, encoding);
    if (outcome === "resolved") {
      resolved++;
      if (choice.action === "remote" && item.kind !== "remote-deleted") downloaded++;
      else if (choice.action === "local" && item.kind === "local-deleted") removed++;
      else if (choice.action === "remote" && item.kind === "remote-deleted") removed++;
      else if (choice.action === "both") uploaded += 2;
      else uploaded++;
    } else if (outcome === "unresolved") unresolved++;
    else if ((outcome.attempt ?? 0) > 1) unresolved++;
    else conflicts.push(outcome);
  }
  if (unresolved > 0) deferCursor = true;

  plugin.settings.index = index;
  if (!deferCursor && loaded.cursor !== null) plugin.settings.changeCursor = loaded.cursor;
  const large = skippedLarge.length ? t("large", { n: skippedLarge.length }) : "";
  const deleted = removed ? t("deleted", { n: removed }) : "";
  const resolvedNote = resolved ? t("conflictsResolved", { n: resolved }) : "";
  const leftNote = unresolved ? t("conflictsLeft", { n: unresolved }) : "";
  plugin.settings.lastSyncSummary = t("summary", {
    vault: ready.vaultName,
    uploaded,
    downloaded,
    unchanged,
    large: `${deleted}${large}${resolvedNote}${leftNote}`,
  });
  await plugin.saveSettings();
  return plugin.settings.lastSyncSummary;
}

interface PendingConflict {
  fileId: string;
  path: string;
  kind: "content" | "remote-deleted" | "local-deleted";
  localBytes: Uint8Array | null;
  remoteBytes: Uint8Array | null;
  remote: RemoteFile | null;
  baseRev: number | null;
  baseMac: string | null;
  encoding: Encoding;
  attempt?: number;
}

type ReadyClient = Awaited<ReturnType<typeof openClient>>;

async function loadRemote(plugin: E2eeSyncPlugin, ready: ReadyClient): Promise<{ remote: Map<string, RemoteFile>; cursor: number | null }> {
  const saved = plugin.settings.changeCursor;
  if (typeof saved === "number" && indexReady(plugin.settings.index)) {
    try {
      const remote = remoteSnapshot(plugin.settings.index);
      let since = saved;
      let cursor = saved;
      for (let pageNo = 0; pageNo < 100; pageNo++) {
        const page = await ready.client.changes(ready.vaultId, since);
        if (!page || !Array.isArray(page.changes) || typeof page.cursor !== "number") {
          throw new Error("The changes response was incomplete");
        }
        for (const change of page.changes) applyChange(remote, change);
        cursor = page.cursor;
        if (!page.more || page.cursor <= since) return { remote, cursor: usableCursor(cursor, remote) };
        since = page.cursor;
      }
      throw new Error("The change log is too long");
    } catch (error) {
      console.warn("Incremental sync failed; falling back to the full manifest", error);
    }
  }
  const manifest = await ready.client.manifest(ready.vaultId);
  const remote = new Map<string, RemoteFile>();
  for (const file of manifest.files) remote.set(file.fileId, { ...file, rev: remoteRev(file) });
  const cursor = typeof manifest.cursor === "number" && Number.isSafeInteger(manifest.cursor) && manifest.cursor >= 0
    ? manifest.cursor
    : null;
  return { remote, cursor: usableCursor(cursor, remote) };
}

function indexReady(index: Record<string, FileIndexEntry>): boolean {
  return Object.values(index).every((entry) =>
    typeof entry.rev === "number" && entry.rev > 0 && (entry.encoding === "plain" || entry.encoding === "e2ee"));
}

function usableCursor(cursor: number | null, remote: Map<string, RemoteFile>): number | null {
  if (cursor === null) return null;
  for (const file of remote.values()) {
    if (remoteRev(file) <= 0) return null;
  }
  return cursor;
}

function remoteSnapshot(index: Record<string, FileIndexEntry>): Map<string, RemoteFile> {
  const remote = new Map<string, RemoteFile>();
  for (const [fileId, entry] of Object.entries(index)) {
    if (typeof entry.rev !== "number" || entry.rev <= 0) continue;
    if (entry.encoding !== "plain" && entry.encoding !== "e2ee") continue;
    remote.set(fileId, {
      fileId,
      contentMac: entry.contentMac,
      size: entry.size,
      mtime: entry.mtime,
      updatedAt: entry.syncedAt ?? 0,
      encoding: entry.encoding,
      rev: entry.rev,
    });
  }
  return remote;
}

function applyChange(remote: Map<string, RemoteFile>, change: ChangeEntry): void {
  if (change.op === "delete") {
    remote.delete(change.fileId);
    return;
  }
  remote.set(change.fileId, {
    fileId: change.fileId,
    contentMac: change.contentMac,
    size: change.size,
    mtime: change.mtime,
    updatedAt: change.updatedAt,
    encoding: change.encoding,
    rev: remoteRev(change),
  });
}

function remoteSide(file: RemoteFile | null): { contentMac: string; encoding: Encoding; rev: number } | null {
  if (!file) return null;
  return { contentMac: file.contentMac, encoding: file.encoding, rev: remoteRev(file) };
}

function baseOf(entry: FileIndexEntry | undefined): { rev?: number; contentMac: string } | null {
  if (!entry) return null;
  return { rev: entry.rev, contentMac: entry.contentMac };
}

function syncedEntry(
  path: string,
  mtime: number,
  size: number,
  contentMac: string,
  encoding: Encoding,
  rev: number | undefined,
  syncedAt = Date.now(),
): FileIndexEntry {
  const entry: FileIndexEntry = { path, mtime, size, contentMac, encoding, syncedAt };
  if (typeof rev === "number" && rev > 0) entry.rev = rev;
  return entry;
}

async function fingerprint(ready: ReadyClient, plain: Uint8Array): Promise<string> {
  return ready.keys ? contentMac(ready.keys.idKey, plain) : plainMac(plain);
}

async function putFile(
  ready: ReadyClient,
  fileId: string,
  path: string,
  plain: Uint8Array,
  mac: string,
  encoding: Encoding,
  mtime: number,
  parentRev: number | null,
): Promise<PutResult> {
  return ready.client.putObject(fileId, {
    vault: ready.vaultName,
    vaultId: ready.vaultId,
    pathCipher: ready.keys
      ? await sealBytes(ready.keys.encKey, new TextEncoder().encode(path), `path:${fileId}`, true)
      : { v: 0, raw: bytesToBase64(new TextEncoder().encode(path)) },
    contentCipher: ready.keys
      ? await sealBytes(ready.keys.encKey, plain, `body:${fileId}`, true)
      : { v: 0, raw: bytesToBase64(plain) },
    contentMac: mac,
    size: plain.byteLength,
    mtime,
    encoding,
    parentRev,
  });
}

async function uploadTracked(
  plugin: E2eeSyncPlugin,
  ready: ReadyClient,
  index: Record<string, FileIndexEntry>,
  input: {
    fileId: string;
    path: string;
    plain: Uint8Array;
    mac: string;
    encoding: Encoding;
    mtime: number;
    size: number;
    parentRev: number | null;
    base: FileIndexEntry | null;
    remote: RemoteFile | null;
  },
): Promise<"uploaded" | PendingConflict> {
  try {
    const result = await putFile(ready, input.fileId, input.path, input.plain, input.mac, input.encoding, input.mtime, input.parentRev);
    index[input.fileId] = syncedEntry(input.path, input.mtime, input.size, input.mac, input.encoding, result.rev || input.remote?.rev);
    return "uploaded";
  } catch (error) {
    if (!(error instanceof SyncConflictError)) throw error;
    return pendingFromError(ready, input.fileId, input.path, input.plain, input.base, input.encoding, error, 0);
  }
}

async function pendingConflict(
  ready: ReadyClient,
  input: {
    fileId: string;
    path: string;
    kind: PendingConflict["kind"];
    localBytes: Uint8Array | null;
    remote: RemoteFile | null;
    base: FileIndexEntry | null;
    encoding: Encoding;
  },
): Promise<PendingConflict> {
  let remoteBytes: Uint8Array | null = null;
  let kind = input.kind;
  if (input.remote && kind !== "remote-deleted") {
    try {
      remoteBytes = await downloadPlain(ready, input.fileId);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      kind = "remote-deleted";
    }
  }
  return {
    fileId: input.fileId,
    path: input.path,
    kind,
    localBytes: input.localBytes,
    remoteBytes,
    remote: kind === "remote-deleted" ? null : input.remote,
    baseRev: input.base?.rev && input.base.rev > 0 ? input.base.rev : null,
    baseMac: input.base?.contentMac ?? null,
    encoding: input.encoding,
  };
}

async function pendingFromError(
  ready: ReadyClient,
  fileId: string,
  path: string,
  localBytes: Uint8Array | null,
  base: FileIndexEntry | null,
  encoding: Encoding,
  error: SyncConflictError,
  attempt: number,
): Promise<PendingConflict> {
  if (!error.file) {
    return {
      fileId,
      path,
      kind: "remote-deleted",
      localBytes,
      remoteBytes: null,
      remote: null,
      baseRev: base?.rev && base.rev > 0 ? base.rev : null,
      baseMac: base?.contentMac ?? null,
      encoding,
      attempt,
    };
  }
  let remoteBytes: Uint8Array | null = null;
  try {
    remoteBytes = await downloadPlain(ready, fileId);
  } catch (readError) {
    if (!isMissingFile(readError)) throw readError;
    return pendingFromError(ready, fileId, path, localBytes, base, encoding, new SyncConflictError("deleted", null), attempt);
  }
  return {
    fileId,
    path,
    kind: "content",
    localBytes,
    remoteBytes,
    remote: error.file,
    baseRev: base?.rev && base.rev > 0 ? base.rev : null,
    baseMac: base?.contentMac ?? null,
    encoding,
    attempt,
  };
}

async function downloadPlain(ready: ReadyClient, fileId: string): Promise<Uint8Array> {
  const stored = await ready.client.getObject(fileId);
  return openBytes(ready.keys?.encKey ?? null, stored.contentCipher, `body:${fileId}`);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && /not on the server/i.test(error.message);
}

function conflictView(item: PendingConflict, index: number, total: number): ConflictView {
  const markdown = item.path.toLowerCase().endsWith(".md");
  return {
    index,
    total,
    path: item.path,
    kind: item.kind,
    localText: markdown ? decodeUtf8(item.localBytes) : null,
    remoteText: markdown ? decodeUtf8(item.remoteBytes) : null,
    baseRev: item.baseRev,
    baseMac: item.baseMac,
    remoteRev: item.remote ? remoteRev(item.remote) || null : null,
    remoteMac: item.remote?.contentMac ?? null,
  };
}

function decodeUtf8(bytes: Uint8Array | null): string | null {
  if (!bytes) return null;
  if (bytes.byteLength === 0) return "";
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\u0000")) return null;
    return text;
  } catch {
    return null;
  }
}

async function applyConflict(
  plugin: E2eeSyncPlugin,
  ready: ReadyClient,
  index: Record<string, FileIndexEntry>,
  item: PendingConflict,
  choice: ConflictChoice,
  device: string,
  encoding: Encoding,
): Promise<"resolved" | "unresolved" | PendingConflict> {
  if (choice.action === "skip") return "unresolved";
  if (item.kind === "remote-deleted") {
    if (choice.action === "remote") {
      await deleteVaultPath(plugin, item.path);
      delete index[item.fileId];
      return "resolved";
    }
    if (choice.action === "local") return uploadCurrent(plugin, ready, index, item, null, encoding);
    return "unresolved";
  }
  if (item.kind === "local-deleted") {
    if (choice.action === "local") {
      await ready.client.deleteObjects(ready.vaultName, [item.fileId], plugin.app.vault.getFiles().length);
      delete index[item.fileId];
      return "resolved";
    }
    if (choice.action === "remote" && item.remote && item.remoteBytes) {
      await writeVaultFile(plugin.app.vault, item.path, item.remoteBytes);
      stampMtime(plugin, item.path, item.remote.mtime);
      const stat = fileStat(plugin, item.path, item.remote.mtime, item.remoteBytes.byteLength);
      index[item.fileId] = syncedEntry(item.path, stat.mtime, stat.size, item.remote.contentMac, item.remote.encoding, remoteRev(item.remote));
      return "resolved";
    }
    return "unresolved";
  }
  if (choice.action === "remote" && item.remote && item.remoteBytes) {
    await writeVaultFile(plugin.app.vault, item.path, item.remoteBytes);
    stampMtime(plugin, item.path, item.remote.mtime);
    const stat = fileStat(plugin, item.path, item.remote.mtime, item.remoteBytes.byteLength);
    index[item.fileId] = syncedEntry(item.path, stat.mtime, stat.size, item.remote.contentMac, item.remote.encoding, remoteRev(item.remote));
    return "resolved";
  }
  if (choice.action === "local") {
    const parent = item.remote && remoteRev(item.remote) > 0 ? remoteRev(item.remote) : null;
    return uploadCurrent(plugin, ready, index, item, parent, encoding);
  }
  if (choice.action === "both" && item.remoteBytes) {
    const copyPath = conflictCopyPath(plugin.app.vault, item.path, device, new Date());
    await writeVaultFile(plugin.app.vault, copyPath, item.remoteBytes);
    new Notice(t("conflictCopy", { path: copyPath }));
    const parent = item.remote && remoteRev(item.remote) > 0 ? remoteRev(item.remote) : null;
    const localOutcome = await uploadCurrent(plugin, ready, index, item, parent, encoding);
    if (localOutcome !== "resolved") return localOutcome;
    try {
      await uploadFreshPath(plugin, ready, index, copyPath, item.remoteBytes, item.remote?.encoding ?? encoding, null);
    } catch (error) {
      if (!(error instanceof SyncConflictError)) throw error;
    }
    return "resolved";
  }
  if (choice.action === "merge") {
    const bytes = new TextEncoder().encode(choice.text);
    if (bytes.byteLength > MAX_FILE_BYTES) return "unresolved";
    await writeVaultFile(plugin.app.vault, item.path, bytes);
    const mac = await fingerprint(ready, bytes);
    const stat = fileStat(plugin, item.path, Date.now(), bytes.byteLength);
    const parent = item.remote && remoteRev(item.remote) > 0 ? remoteRev(item.remote) : null;
    try {
      const result = await putFile(ready, item.fileId, item.path, bytes, mac, encoding, stat.mtime, parent);
      index[item.fileId] = syncedEntry(item.path, stat.mtime, stat.size, mac, encoding, result.rev);
      return "resolved";
    } catch (error) {
      if (!(error instanceof SyncConflictError)) throw error;
      return pendingFromError(ready, item.fileId, item.path, bytes, index[item.fileId] ?? null, encoding, error, (item.attempt ?? 0) + 1);
    }
  }
  return "unresolved";
}

async function uploadCurrent(
  plugin: E2eeSyncPlugin,
  ready: ReadyClient,
  index: Record<string, FileIndexEntry>,
  item: PendingConflict,
  parentRev: number | null,
  encoding: Encoding,
): Promise<"resolved" | PendingConflict | "unresolved"> {
  const file = plugin.app.vault.getAbstractFileByPath(item.path);
  if (!(file instanceof TFile)) return "unresolved";
  const plain = new Uint8Array(await plugin.app.vault.readBinary(file));
  if (plain.byteLength > MAX_FILE_BYTES) return "unresolved";
  const mac = await fingerprint(ready, plain);
  try {
    const result = await putFile(ready, item.fileId, item.path, plain, mac, encoding, file.stat.mtime, parentRev);
    index[item.fileId] = syncedEntry(item.path, file.stat.mtime, file.stat.size, mac, encoding, result.rev);
    return "resolved";
  } catch (error) {
    if (!(error instanceof SyncConflictError)) throw error;
    return pendingFromError(ready, item.fileId, item.path, plain, index[item.fileId] ?? null, encoding, error, (item.attempt ?? 0) + 1);
  }
}

async function uploadFreshPath(
  plugin: E2eeSyncPlugin,
  ready: ReadyClient,
  index: Record<string, FileIndexEntry>,
  path: string,
  plain: Uint8Array,
  encoding: Encoding,
  parentRev: number | null,
): Promise<void> {
  const fileId = ready.keys
    ? await fileIdForPath(ready.keys.idKey, path, ready.vaultName)
    : await plainFileId(ready.vaultName, path);
  const mac = await fingerprint(ready, plain);
  const stat = fileStat(plugin, path, Date.now(), plain.byteLength);
  const result = await putFile(ready, fileId, path, plain, mac, encoding, stat.mtime, parentRev);
  index[fileId] = syncedEntry(path, stat.mtime, stat.size, mac, encoding, result.rev);
}

async function deleteVaultPath(plugin: E2eeSyncPlugin, path: string): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) await plugin.app.vault.delete(file);
}

function fileStat(plugin: E2eeSyncPlugin, path: string, fallbackMtime: number, fallbackSize: number): { mtime: number; size: number } {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) return { mtime: file.stat.mtime, size: file.stat.size };
  return { mtime: fallbackMtime, size: fallbackSize };
}

function deviceLabel(): string {
  let name = "device";
  try {
    const os = require("os") as { hostname?: () => string };
    const host = os.hostname?.()?.trim();
    if (host) name = host;
  } catch {
    name = "device";
  }
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
  return (cleaned || "device").slice(0, 40);
}

function conflictCopyPath(vault: Vault, path: string, device: string, when: Date): string {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  const pad = (part: number) => String(part).padStart(2, "0");
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}${pad(when.getHours())}${pad(when.getMinutes())}`;
  const label = `Conflicted copy ${device} ${stamp}`;
  let candidate = `${dir}${stem} (${label})${ext}`;
  let n = 2;
  while (vault.getAbstractFileByPath(candidate)) {
    candidate = `${dir}${stem} (${label} ${n})${ext}`;
    n++;
  }
  return candidate;
}

async function pullRemote(
  plugin: E2eeSyncPlugin,
  ready: Awaited<ReturnType<typeof openClient>>,
  remoteFile: RemoteFile,
  index: E2eeSyncPlugin["settings"]["index"],
): Promise<boolean> {
  if (remoteFile.size > MAX_FILE_BYTES) return false;
  const known = index[remoteFile.fileId]?.path;
  if (known && !shouldSync(plugin, known)) return false;
  const stored = await ready.client.getObject(remoteFile.fileId);
  const path = safeVaultPath(new TextDecoder().decode(
    await openBytes(ready.keys?.encKey ?? null, stored.pathCipher, `path:${remoteFile.fileId}`),
  ));
  if (!shouldSync(plugin, path)) return false;
  const data = await openBytes(ready.keys?.encKey ?? null, stored.contentCipher, `body:${remoteFile.fileId}`);
  await writeVaultFile(plugin.app.vault, path, data);
  stampMtime(plugin, path, remoteFile.mtime);
  const rev = remoteRev(remoteFile);
  index[remoteFile.fileId] = {
    path,
    mtime: remoteFile.mtime,
    size: data.byteLength,
    contentMac: remoteFile.contentMac,
    encoding: remoteFile.encoding,
    syncedAt: Date.now(),
    ...(rev > 0 ? { rev } : {}),
  };
  return true;
}

function shouldSync(plugin: E2eeSyncPlugin, path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (PLUGIN_FILES.has(normalized)) return true;
  if (!isSyncablePath(normalized)) return false;
  return suffixSelected(normalized, plugin.settings.syncSuffixes, plugin.settings.syncOther, plugin.settings.customSuffixes);
}

export async function restoreVault(
  plugin: E2eeSyncPlugin,
  remote: { id: string; name: string },
  mode: RestoreMode,
  folder = "",
): Promise<string> {
  const token = plugin.settings.apiToken.trim();
  if (!token) throw new Error(t("needLogin"));
  const vaultName = remote.name.trim();
  const vaultId = remote.id.trim();
  if (!vaultName || !vaultId) throw new Error(t("needBind"));
  const host = resolveSyncHost(plugin.settings.host);
  const client = new SyncClient(host, token, (seconds) => plugin.setStatus(t("retrying", { n: seconds })));
  const manifest = await client.manifest(vaultId);
  const needsKey = manifest.files.some((file) => file.encoding === "e2ee");
  if (needsKey && plugin.settings.secretKey.trim().length < MIN_SECRET_LENGTH) throw new Error(t("needSecret"));
  const keys = needsKey ? await deriveKeys(requireSecret(plugin.settings.secretKey)) : null;
  const destination = mode === "create" ? prepareRestoreFolder(plugin, folder) : "";
  const written: Array<{ path: string; fileId: string; contentMac: string; encoding: Encoding; rev: number }> = [];
  let restored = 0;
  for (const file of manifest.files) {
    const stored = await client.getObject(file.fileId);
    const path = safeVaultPath(new TextDecoder().decode(
      await openBytes(keys?.encKey ?? null, stored.pathCipher, `path:${file.fileId}`),
    ));
    const data = await openBytes(keys?.encKey ?? null, stored.contentCipher, `body:${file.fileId}`);
    if (mode === "create") writeOutside(destination, path, data);
    else await writeVaultFile(plugin.app.vault, path, data);
    written.push({ path, fileId: file.fileId, contentMac: file.contentMac, encoding: file.encoding, rev: remoteRev(file) });
    restored++;
    plugin.setStatus(t("restoreProgress", { done: restored, total: manifest.files.length }));
  }
  if (mode === "overwrite") {
    await plugin.bindVault(vaultName, needsKey, vaultId);
    const index = { ...plugin.settings.index };
    const syncedAt = Date.now();
    for (const item of written) {
      const local = plugin.app.vault.getAbstractFileByPath(item.path);
      if (!(local instanceof TFile)) continue;
      index[item.fileId] = {
        path: item.path,
        mtime: local.stat.mtime,
        size: local.stat.size,
        contentMac: item.contentMac,
        encoding: item.encoding,
        syncedAt,
        ...(item.rev > 0 ? { rev: item.rev } : {}),
      };
    }
    plugin.settings.index = index;
    const revisionsKnown = manifest.files.every((file) => remoteRev(file) > 0);
    if (typeof manifest.cursor === "number" && (manifest.files.length === 0 || revisionsKnown)) {
      plugin.settings.changeCursor = manifest.cursor;
    } else {
      plugin.settings.changeCursor = null;
    }
  }
  if (mode === "create") {
    installPluginCopy(plugin, destination);
    writeBoundSettings(destination, vaultName, vaultId, needsKey, plugin.settings.accountId);
    registerVault(destination);
    openCreatedVault(plugin, destination);
  }
  plugin.settings.lastSyncSummary = mode === "create"
    ? t("openedVault", { vault: vaultName, path: destination, count: restored })
    : t("overwritten", { vault: vaultName, count: restored });
  await plugin.saveSettings();
  return plugin.settings.lastSyncSummary;
}

export class RestoreModal extends Modal {
  private selected = "";
  private vaults: VaultStat[] = [];
  private keyBox: HTMLElement | null = null;
  private keyInput: HTMLInputElement | null = null;

  constructor(app: App, private readonly plugin: E2eeSyncPlugin) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("restoreTitle"));
    this.contentEl.setText(t("loadingVaults"));
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const token = this.plugin.settings.apiToken.trim();
      if (!token) throw new Error(t("needLogin"));
      const host = resolveSyncHost(this.plugin.settings.host);
      const listed = await new SyncClient(host, token).vaults();
      this.render(listed.vaults.filter((vault) => vault.id && vault.name));
    } catch (error) {
      this.contentEl.empty();
      this.contentEl.createEl("p", { text: error instanceof Error ? error.message : t("readFailed") });
    }
  }

  private render(vaults: VaultStat[]): void {
    this.contentEl.empty();
    this.vaults = vaults;
    if (vaults.length === 0) {
      this.contentEl.createEl("p", { text: t("noBackups") });
      return;
    }
    this.selected = vaults[0]?.id ?? "";
    this.contentEl.createEl("p", { text: t("restoreHelp") });
    this.contentEl.createEl("p", { text: t("restoreCurrent", { name: this.plugin.app.vault.getName() }) });
    const list = this.contentEl.createDiv({ cls: "e2ee-sync-vaults" });
    const rows: HTMLElement[] = [];
    for (const vault of vaults) {
      const row = list.createDiv({ cls: "e2ee-sync-vault" });
      row.createEl("div", { text: vault.name });
      row.createEl("div", {
        text: `${t("vaultMeta", { files: vault.files, bytes: formatBytes(vault.bytes), time: formatStamp(vault.lastSyncAt) })} · ${vault.encrypted ? t("encryptedLabel") : t("plainLabel")}`,
        cls: "e2ee-sync-status-line",
      });
      row.onclick = () => {
        this.selected = vault.id;
        for (const item of rows) item.toggleClass("is-selected", item === row);
        this.refreshKey();
      };
      rows.push(row);
    }
    rows[0]?.addClass("is-selected");
    this.keyBox = this.contentEl.createDiv({ cls: "e2ee-sync-name" });
    this.keyBox.createEl("div", { text: t("restoreKey") });
    this.keyBox.createEl("p", { text: t("restoreKeyDesc"), cls: "e2ee-sync-status-line" });
    this.keyInput = this.keyBox.createEl("input", { type: "password" });
    this.keyInput.value = this.plugin.settings.secretKey;
    this.refreshKey();
    const actions = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
    const overwrite = actions.createEl("button", { text: t("overwrite"), cls: "mod-warning" });
    overwrite.onclick = () => this.choose("overwrite");
    const create = actions.createEl("button", { text: t("createVault") });
    create.onclick = () => { void this.chooseCreate(); };
    const cancel = actions.createEl("button", { text: t("cancel") });
    cancel.onclick = () => this.close();
  }

  private refreshKey(): void {
    const vault = this.vaults.find((item) => item.id === this.selected);
    if (!this.keyBox) return;
    this.keyBox.style.display = vault?.encrypted ? "" : "none";
  }

  private async applyKey(remote: VaultStat): Promise<boolean> {
    if (!remote.encrypted) return true;
    const key = this.keyInput?.value.trim() ?? "";
    if (key.length < MIN_SECRET_LENGTH) {
      new Notice(t("needSecret"));
      return false;
    }
    this.plugin.setSecret(key);
    await this.plugin.saveSettings();
    return true;
  }

  private choose(mode: RestoreMode): void {
    const remote = this.vaults.find((vault) => vault.id === this.selected);
    if (!remote) return;
    void this.finish(remote, mode);
  }

  private async chooseCreate(): Promise<void> {
    const remote = this.vaults.find((vault) => vault.id === this.selected);
    if (!remote) return;
    if (!await this.applyKey(remote)) return;
    const folder = await chooseRestoreFolder(this.app);
    if (!folder) return;
    const name = folderName(folder);
    if (!name || vaultNameTaken(folder)) {
      new Notice(t("restoreNameTaken", { name: name || folder }));
      return;
    }
    if (folderHasFiles(folder)) {
      const ok = await confirmOverwrite(this.app);
      if (!ok) return;
    }
    this.close();
    void this.plugin.restoreNow(remote, "create", folder);
  }

  private async finish(remote: VaultStat, mode: RestoreMode): Promise<void> {
    if (!await this.applyKey(remote)) return;
    this.close();
    void this.plugin.restoreNow(remote, mode);
  }
}

export function notifyResult(manual: boolean, summary: string): void {
  if (manual) new Notice(summary);
}

async function openClient(plugin: E2eeSyncPlugin): Promise<{
  host: string;
  client: SyncClient;
  keys: Awaited<ReturnType<typeof deriveKeys>> | null;
  vaultName: string;
  vaultId: string;
}> {
  const token = plugin.settings.apiToken.trim();
  if (!token) throw new Error(t("needLogin"));
  const vaultName = plugin.settings.boundVault.trim();
  const vaultId = plugin.settings.boundVaultId.trim();
  if (!vaultName || !vaultId || plugin.settings.boundAccountId !== plugin.settings.accountId || /[\u0000-\u001f\u007f\\/]/.test(vaultName) || vaultName.length > 120) {
    throw new Error(t("needBind"));
  }
  await plugin.alignEncryptionWithRemote();
  const host = resolveSyncHost(plugin.settings.host);
  const keys = plugin.settings.encryptNotes ? await deriveKeys(requireSecret(plugin.settings.secretKey)) : null;
  return {
    host,
    client: new SyncClient(host, token, (seconds) => plugin.setStatus(t("retrying", { n: seconds }))),
    keys,
    vaultName,
    vaultId,
  };
}

function requireSecret(secret: string): string {
  const value = secret.trim();
  if (value.length < MIN_SECRET_LENGTH) throw new Error(t("needSecret"));
  return value;
}

function writeBoundSettings(dest: string, boundVault: string, boundVaultId: string, encryptNotes: boolean, accountId: string): void {
  const fs = nodeFs();
  const path = fs.resolve(dest, ".obsidian", "plugins", "e2ee-sync", "data.json");
  fs.mkdirSync(fs.dirname(path), { recursive: true });
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(fs.readText(path)) as Record<string, unknown>;
  } catch {
    current = {};
  }
  current.boundVault = boundVault;
  current.boundVaultId = boundVaultId;
  current.boundAccountId = accountId;
  const bindings = current.vaultBindings && typeof current.vaultBindings === "object"
    ? current.vaultBindings as Record<string, unknown>
    : {};
  bindings[accountId] = { vaultId: boundVaultId, vaultName: boundVault, encryptNotes };
  current.vaultBindings = bindings;
  current.encryptNotes = encryptNotes;
  fs.writeText(path, JSON.stringify(current, null, 2));
}

function prepareRestoreFolder(plugin: E2eeSyncPlugin, folder: string): string {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) throw new Error(t("desktopOnly"));
  const fs = nodeFs();
  const dest = fs.resolve(folder);
  if (!dest || vaultNameTaken(dest)) throw new Error(t("restoreNameTaken", { name: folderName(dest) || dest }));
  fs.mkdirSync(dest, { recursive: true });
  return dest;
}

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function vaultNameTaken(folder: string): boolean {
  const fs = nodeFs();
  const dest = fs.resolve(folder);
  const name = folderName(dest).toLowerCase();
  if (!name || name === "." || name === "..") return true;
  const configDir = obsidianConfigDir();
  if (!configDir) return false;
  try {
    const parsed = JSON.parse(fs.readText(fs.resolve(configDir, "obsidian.json"))) as {
      vaults?: Record<string, { path?: string }>;
    };
    for (const vault of Object.values(parsed.vaults ?? {})) {
      if (typeof vault.path !== "string" || !vault.path) continue;
      const existing = fs.resolve(vault.path);
      if (existing.toLowerCase() === dest.toLowerCase()) return true;
      if (folderName(existing).toLowerCase() === name) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function folderHasFiles(folder: string): boolean {
  const fs = nodeFs();
  if (!fs.existsSync(folder)) return false;
  return fs.list(folder).some((name) => name !== ".DS_Store");
}

function chooseRestoreFolder(app: App): Promise<string> {
  const picked = pickDirectory();
  if (picked) return picked;
  return askFolderPath(app);
}

function pickDirectory(): Promise<string> | null {
  try {
    const electron = require("electron") as {
      dialog?: { showOpenDialog: (options: { properties: string[] }) => Promise<{ canceled?: boolean; filePaths?: string[] }> };
      remote?: { dialog?: { showOpenDialog: (options: { properties: string[] }) => Promise<{ canceled?: boolean; filePaths?: string[] }> } };
    };
    const dialog = electron.dialog ?? electron.remote?.dialog;
    if (!dialog) return null;
    return dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }).then((result) => {
      if (result.canceled || !result.filePaths?.[0]) return "";
      return result.filePaths[0];
    });
  } catch {
    return null;
  }
}

function askFolderPath(app: App): Promise<string> {
  return new Promise((resolve) => {
    const modal = new FolderPathModal(app, resolve);
    modal.open();
  });
}

function confirmOverwrite(app: App): Promise<boolean> {
  return new Promise((resolve) => {
    new OverwriteFolderConfirm(app, resolve).open();
  });
}

class FolderPathModal extends Modal {
  private settled = false;
  private input: HTMLInputElement | null = null;

  constructor(app: App, private readonly choose: (path: string) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("restorePickFolder"));
    this.contentEl.createEl("p", { text: t("restoreFolderPath") });
    this.input = this.contentEl.createEl("input", { type: "text" });
    this.input.style.width = "100%";
    const row = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
    const ok = row.createEl("button", { text: t("createVault"), cls: "mod-cta" });
    ok.onclick = () => this.finish(this.input?.value.trim() ?? "");
    const cancel = row.createEl("button", { text: t("cancel") });
    cancel.onclick = () => this.finish("");
  }

  onClose(): void {
    this.finish("");
  }

  private finish(path: string): void {
    if (this.settled) return;
    this.settled = true;
    this.choose(path);
    this.close();
  }
}

class OverwriteFolderConfirm extends Modal {
  private settled = false;

  constructor(app: App, private readonly choose: (ok: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("createVault"));
    this.contentEl.createEl("p", { text: t("restoreNotEmpty") });
    const row = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
    const ok = row.createEl("button", { text: t("restoreOverwriteFiles"), cls: "mod-warning" });
    ok.onclick = () => this.finish(true);
    const cancel = row.createEl("button", { text: t("cancel") });
    cancel.onclick = () => this.finish(false);
  }

  onClose(): void {
    this.finish(false);
  }

  private finish(ok: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.choose(ok);
    this.close();
  }
}

function writeOutside(dest: string, relative: string, data: Uint8Array): void {
  const fs = nodeFs();
  const full = fs.resolve(dest, ...relative.split("/"));
  assertInside(dest, full);
  fs.mkdirSync(fs.dirname(full), { recursive: true });
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  fs.writeFileSync(full, copy);
}

function assertInside(parent: string, target: string): void {
  const fs = nodeFs();
  const root = fs.resolve(parent);
  const full = fs.resolve(target);
  if (full !== root && !full.startsWith(root + fs.sep)) throw new Error(t("pathEscape"));
}

function installPluginCopy(plugin: E2eeSyncPlugin, dest: string): void {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return;
  const fs = nodeFs();
  const source = fs.resolve(adapter.getBasePath(), ".obsidian", "plugins", "e2ee-sync");
  const target = fs.resolve(dest, ".obsidian", "plugins", "e2ee-sync");
  fs.mkdirSync(target, { recursive: true });
  for (const file of ["manifest.json", "main.js", "styles.css"]) {
    fs.copyFile(fs.resolve(source, file), fs.resolve(target, file));
  }
  enablePlugin(fs, dest);
}

function enablePlugin(fs: NodeFs, dest: string): void {
  const listPath = fs.resolve(dest, ".obsidian", "community-plugins.json");
  let list: string[] = [];
  try {
    const parsed = JSON.parse(fs.readText(listPath)) as unknown;
    if (Array.isArray(parsed)) list = parsed.filter((item) => typeof item === "string");
  } catch {
    list = [];
  }
  if (list.includes("e2ee-sync")) return;
  list.push("e2ee-sync");
  fs.writeText(listPath, JSON.stringify(list, null, 2));
}

function openCreatedVault(plugin: E2eeSyncPlugin, dest: string): void {
  try {
    const electron = require("electron") as {
      ipcRenderer?: { send?: (channel: string, ...args: unknown[]) => void };
    };
    electron.ipcRenderer?.send?.("vault-open", dest, false);
  } catch (error) {
    console.warn("Could not ask Obsidian to open the new vault", error);
  }
  new CreatedVaultModal(plugin.app, dest).open();
}

class CreatedVaultModal extends Modal {
  constructor(app: App, private readonly folder: string) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("restoreCreatedTitle"));
    this.contentEl.createEl("p", { text: t("restoreCreatedGuide", { path: this.folder }) });
    const row = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
    const open = row.createEl("button", { text: t("restoreOpenFolder"), cls: "mod-cta" });
    open.onclick = () => revealFolder(this.folder);
    const close = row.createEl("button", { text: t("cancel") });
    close.onclick = () => this.close();
  }
}

function revealFolder(folder: string): void {
  try {
    const shell = (require("electron") as {
      shell?: { showItemInFolder?: (target: string) => void; openPath?: (target: string) => Promise<string> };
    }).shell;
    if (shell?.showItemInFolder) shell.showItemInFolder(folder);
    else void shell?.openPath?.(folder);
  } catch (error) {
    console.warn("Could not show the new vault folder", error);
  }
}

function registerVault(dest: string): void {
  if (!isDesktopApp()) return;
  const fs = nodeFs();
  const configDir = obsidianConfigDir();
  if (!configDir) {
    warnMissingObsidianConfig();
    return;
  }
  const configPath = fs.resolve(configDir, "obsidian.json");
  let parsed: { vaults?: Record<string, { path: string; ts: number; open?: boolean }> } = {};
  try {
    parsed = JSON.parse(fs.readText(configPath)) as typeof parsed;
  } catch {
    parsed = {};
  }
  parsed.vaults ??= {};
  const resolved = fs.resolve(dest);
  const existing = Object.entries(parsed.vaults).find(([, vault]) => fs.resolve(vault.path) === resolved);
  const id = existing?.[0] ?? [...randomBytes(8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  parsed.vaults[id] = { ...(existing?.[1] ?? {}), path: dest, ts: Date.now(), open: true };
  fs.writeText(configPath, JSON.stringify(parsed, null, 2));
}

function nodeFs(): NodeFs {
  const fs = require("fs") as unknown as {
    existsSync: (path: string) => boolean;
    mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
    writeFileSync: (path: string, data: Uint8Array | string) => void;
    readFileSync: (path: string, encoding: "utf8") => string;
    copyFileSync: (from: string, to: string) => void;
    statSync: (path: string) => { mtimeMs: number };
    utimesSync: (path: string, atime: Date, mtime: Date) => void;
    readdirSync: (path: string) => string[];
  };
  const path = require("path") as {
    sep: string;
    dirname: (path: string) => string;
    resolve: (...paths: string[]) => string;
  };
  return {
    sep: path.sep,
    existsSync: (target) => fs.existsSync(target),
    mkdirSync: (target, options) => fs.mkdirSync(target, options),
    writeFileSync: (target, data) => fs.writeFileSync(target, data),
    readText: (target) => fs.readFileSync(target, "utf8"),
    writeText: (target, data) => fs.writeFileSync(target, data),
    copyFile: (from, to) => fs.copyFileSync(from, to),
    statMtime: (target) => {
      try {
        return fs.statSync(target).mtimeMs;
      } catch {
        return 0;
      }
    },
    utimes: (target, ms) => {
      const when = new Date(ms);
      fs.utimesSync(target, when, when);
    },
    list: (target) => {
      try {
        return fs.readdirSync(target);
      } catch {
        return [];
      }
    },
    dirname: (target) => path.dirname(target),
    resolve: (...parts) => path.resolve(...parts),
  };
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 1024) return `${Math.max(0, Math.round(value))} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatStamp(ms: number): string {
  const date = new Date(ms);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface NodeFs {
  sep: string;
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  writeFileSync: (path: string, data: Uint8Array) => void;
  readText: (path: string) => string;
  writeText: (path: string, data: string) => void;
  copyFile: (from: string, to: string) => void;
    statMtime: (path: string) => number;
    utimes: (path: string, ms: number) => void;
    list: (path: string) => string[];
  dirname: (path: string) => string;
  resolve: (...paths: string[]) => string;
}

declare function require(moduleName: string): NodeFs;

function safeVaultPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(t("badBackupPath"));
  }
  if (!isSyncablePath(normalized)) throw new Error(t("blockedPath", { path: normalized }));
  return normalized;
}

function stampMtime(plugin: E2eeSyncPlugin, path: string, mtime: number): void {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter) || !Number.isFinite(mtime) || mtime <= 0) return;
  const fs = nodeFs();
  const full = fs.resolve(adapter.getBasePath(), ...path.split("/"));
  try {
    fs.utimes(full, mtime);
  } catch (error) {
    console.warn("Could not keep the synced file time", error);
  }
}

async function writeVaultFile(vault: Vault, path: string, data: Uint8Array): Promise<void> {
  const folders = path.split("/");
  folders.pop();
  let current = "";
  for (const folder of folders) {
    current = current ? `${current}/${folder}` : folder;
    if (!vault.getAbstractFileByPath(current)) {
      try {
        await vault.createFolder(current);
      } catch (error) {
        if (!vault.getAbstractFileByPath(current)) throw error;
      }
    }
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const buffer = copy.buffer;
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await vault.modifyBinary(existing, buffer);
    return;
  }
  if (existing) throw new Error(t("folderConflict", { path }));
  await vault.createBinary(path, buffer);
}
