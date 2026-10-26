import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig, StorageConfig } from "./config";
import { resolveR2 } from "./config";
import type { SyncDb } from "./db";
import { R2Client, resolveR2Credentials } from "./r2";
import { QiniuBlobStore, storedBytes, type BlobStore } from "./storage";

interface LayoutMarker {
  kind: StorageConfig["kind"];
  inlineMaxBytes: number;
}

interface ListedObject {
  accountId: string;
  fileId: string;
  size: number;
}

interface RemoteStore extends BlobStore {
  list?: () => Promise<ListedObject[]>;
}

const ACCOUNT_ID = /^[0-9a-f-]{36}$/i;
const FILE_ID = /^[0-9a-f]{64}$/;

export async function migrateBlobLayout(config: AppConfig, db: SyncDb, remote?: RemoteStore): Promise<number> {
  const markerPath = join(config.dataDir, "blob-layout.json");
  const previous = readMarker(markerPath);
  if (previous?.kind === "qiniu" && config.storage.kind !== "qiniu") {
    throw new Error("The previous blob layout was Qiniu. Keep Qiniu configured until those objects are copied.");
  }
  const target = config.storage.kind;
  const inlineMax = config.storage.kind === "r2" ? config.storage.inlineMaxBytes : 0;
  const same = previous?.kind === target && (target !== "r2" || previous.inlineMaxBytes === inlineMax);
  const active = remote ?? await openRemote(config);
  const legacyR2 = active && config.storage.kind === "r2"
    ? active
    : await openLegacyR2(previous);

  let moved = 0;
  if (!(same && target === "file")) {
    for (const file of listFileBlobs(config.dataDir)) {
      const json = readFileSync(file.path, "utf8");
      await place(config, db, active, legacyR2, file.accountId, file.fileId, json);
      moved++;
    }
  }

  for (const row of await db.listBlobs()) {
    if (belongsInDatabase(target, row.content, inlineMax)) continue;
    await place(config, db, active, legacyR2, row.accountId, row.fileId, row.content);
    moved++;
  }

  const listed = legacyR2?.list;
  if (listed && previous?.kind === "r2" && (target !== "r2" || !same)) {
    for (const object of await listed.call(legacyR2)) {
      if (target === "r2" && object.size >= inlineMax) continue;
      let json: string;
      try {
        json = await legacyR2.get(object.accountId, object.fileId);
      } catch (error) {
        if (error instanceof Error && error.message.includes("no content")) continue;
        throw error;
      }
      await place(config, db, active, legacyR2, object.accountId, object.fileId, json);
      moved++;
    }
  }

  writeFileSync(markerPath, JSON.stringify({ kind: target, inlineMaxBytes: inlineMax }, null, 2));
  return moved;
}

function belongsInDatabase(kind: StorageConfig["kind"], content: string, inlineMax: number): boolean {
  if (kind === "database") return true;
  return kind === "r2" && storedBytes(content) < inlineMax;
}

async function place(
  config: AppConfig,
  db: SyncDb,
  active: RemoteStore | undefined,
  legacyR2: RemoteStore | undefined,
  accountId: string,
  fileId: string,
  json: string,
): Promise<void> {
  const kind = config.storage.kind;
  const inlineMax = kind === "r2" ? config.storage.inlineMaxBytes : 0;
  const bytes = storedBytes(json);
  const keepDb = kind === "database" || (kind === "r2" && bytes < inlineMax);
  const keepR2 = kind === "r2" && bytes >= inlineMax;
  const keepQiniu = kind === "qiniu";
  if (kind === "file") writeFileBlob(config.dataDir, accountId, fileId, json);
  if (keepDb) await db.putBlob(accountId, fileId, json);
  if (keepR2) {
    const remote = active ?? legacyR2;
    if (!remote) throw new Error("R2 storage is not configured");
    await remote.put(accountId, fileId, json);
  }
  if (keepQiniu) {
    if (!active) throw new Error("Qiniu storage is not configured");
    await active.put(accountId, fileId, json);
  }
  if (kind !== "file") removeFileBlob(config.dataDir, accountId, fileId);
  if (!keepDb) await db.deleteBlob(accountId, fileId);
  if (!keepR2) await legacyR2?.delete(accountId, fileId);
}

async function openRemote(config: AppConfig): Promise<RemoteStore | undefined> {
  if (config.storage.kind === "r2") {
    return new R2Client(config.storage.endpoint, config.storage.bucket, config.storage);
  }
  if (config.storage.kind === "qiniu") return new QiniuBlobStore(config.storage);
  return undefined;
}

async function openLegacyR2(previous: LayoutMarker | null): Promise<RemoteStore | undefined> {
  if (previous?.kind !== "r2") return undefined;
  if (process.env.STORAGE?.trim().toLowerCase() === "r2") return undefined;
  let parsed: ReturnType<typeof resolveR2>;
  try {
    parsed = resolveR2(process.env);
  } catch {
    throw new Error("The previous blob layout was R2. Keep the R2 settings for one startup so those objects can be moved.");
  }
  const credentials = await resolveR2Credentials(parsed);
  return new R2Client(parsed.endpoint, parsed.bucket, credentials);
}

function listFileBlobs(dataDir: string): { accountId: string; fileId: string; path: string }[] {
  const root = join(dataDir, "blobs");
  if (!existsSync(root)) return [];
  const found: { accountId: string; fileId: string; path: string }[] = [];
  for (const accountId of readdirSync(root)) {
    if (!ACCOUNT_ID.test(accountId)) continue;
    const dir = join(root, accountId);
    if (!statSync(dir).isDirectory()) continue;
    for (const fileId of readdirSync(dir)) {
      if (!FILE_ID.test(fileId)) continue;
      const path = join(dir, fileId);
      if (!statSync(path).isFile()) continue;
      found.push({ accountId, fileId, path });
    }
  }
  return found;
}

function writeFileBlob(dataDir: string, accountId: string, fileId: string, json: string): void {
  const path = join(dataDir, "blobs", accountId, fileId);
  mkdirSync(join(dataDir, "blobs", accountId), { recursive: true });
  writeFileSync(path, json);
}

function removeFileBlob(dataDir: string, accountId: string, fileId: string): void {
  rmSync(join(dataDir, "blobs", accountId, fileId), { force: true });
}

function readMarker(path: string): LayoutMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LayoutMarker>;
    if (parsed.kind !== "file" && parsed.kind !== "database" && parsed.kind !== "qiniu" && parsed.kind !== "r2") return null;
    return { kind: parsed.kind, inlineMaxBytes: Number(parsed.inlineMaxBytes) || 0 };
  } catch {
    return null;
  }
}
