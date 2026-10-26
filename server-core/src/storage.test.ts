import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppConfig } from "./config";
import { openDatabase } from "./db";
import { migrateBlobLayout } from "./migrate";
import { parseListObjects, parseObjectKey, presignR2Url } from "./r2";
import { HybridBlobStore, type BlobStore } from "./storage";

const account = "123e4567-e89b-12d3-a456-426614174000";
const smallId = "a".repeat(64);
const largeId = "b".repeat(64);

class MemoryStore implements BlobStore {
  readonly objects = new Map<string, string>();

  async put(accountId: string, fileId: string, json: string): Promise<void> {
    this.objects.set(`${accountId}/${fileId}`, json);
  }

  async get(accountId: string, fileId: string): Promise<string> {
    const value = this.objects.get(`${accountId}/${fileId}`);
    if (value === undefined) throw new Error("The object store has no content for this file");
    return value;
  }

  async delete(accountId: string, fileId: string): Promise<void> {
    this.objects.delete(`${accountId}/${fileId}`);
  }
}

function config(dir: string, storage: AppConfig["storage"]): AppConfig {
  return {
    port: 0,
    dataDir: dir,
    sessionSecret: "test",
    oidc: null,
    allowDevLogin: true,
    mode: "central",
    requireEncryption: false,
    accessToken: "",
    database: { kind: "sqlite", path: join(dir, "sync.db") },
    storage,
  };
}

test("objects under 128 bytes stay in sqlite and larger ones go to the remote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-hybrid-"));
  const db = await openDatabase(config(dir, { kind: "file" }));
  const remote = new MemoryStore();
  const store = new HybridBlobStore(db, remote, 128);
  const small = "s".repeat(127);
  const large = "l".repeat(128);
  await store.put(account, smallId, small);
  await store.put(account, largeId, large);
  assert.equal(await db.getBlob(account, smallId), small);
  assert.equal(await db.getBlob(account, largeId), undefined);
  assert.equal(remote.objects.get(`${account}/${largeId}`), large);
  assert.equal(remote.objects.has(`${account}/${smallId}`), false);
  assert.equal(await store.get(account, smallId), small);
  assert.equal(await store.get(account, largeId), large);
  await store.delete(account, smallId);
  await store.delete(account, largeId);
  assert.equal(await db.getBlob(account, smallId), undefined);
  assert.equal(remote.objects.size, 0);
  await db.close();
});

test("startup moves existing files into the hybrid layout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-migrate-"));
  const appConfig = config(dir, {
    kind: "r2",
    endpoint: "https://example.r2.cloudflarestorage.com",
    bucket: "e2e-sync",
    inlineMaxBytes: 128,
    accessKeyId: "id",
    secretAccessKey: "secret",
    apiToken: "",
  });
  const db = await openDatabase(appConfig);
  mkdirSync(join(dir, "blobs", account), { recursive: true });
  writeFileSync(join(dir, "blobs", account, smallId), "tiny");
  writeFileSync(join(dir, "blobs", account, largeId), "y".repeat(200));
  const remote = new MemoryStore();
  assert.equal(await migrateBlobLayout(appConfig, db, remote), 2);
  assert.equal(await db.getBlob(account, smallId), "tiny");
  assert.equal(remote.objects.get(`${account}/${largeId}`), "y".repeat(200));
  assert.equal(existsSync(join(dir, "blobs", account, smallId)), false);
  assert.equal(existsSync(join(dir, "blobs", account, largeId)), false);
  assert.equal(await migrateBlobLayout(appConfig, db, remote), 0);
  const marker = JSON.parse(readFileSync(join(dir, "blob-layout.json"), "utf8")) as { kind: string; inlineMaxBytes: number };
  assert.equal(marker.kind, "r2");
  assert.equal(marker.inlineMaxBytes, 128);
  await db.close();
});

test("database storage still accepts every object and file storage can take them back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-db-"));
  const database = config(dir, { kind: "database" });
  const db = await openDatabase(database);
  mkdirSync(join(dir, "blobs", account), { recursive: true });
  writeFileSync(join(dir, "blobs", account, largeId), "notes");
  assert.equal(await migrateBlobLayout(database, db), 1);
  assert.equal(await db.getBlob(account, largeId), "notes");
  assert.equal(existsSync(join(dir, "blobs", account, largeId)), false);
  const files = config(dir, { kind: "file" });
  assert.equal(await migrateBlobLayout(files, db), 1);
  assert.equal(await db.getBlob(account, largeId), undefined);
  assert.equal(existsSync(join(dir, "blobs", account, largeId)), true);
  await db.close();
});

test("presigned r2 urls bind the method, key, and expiry", () => {
  const now = new Date("2026-01-02T03:04:05.000Z");
  const input = {
    endpoint: "https://example.r2.cloudflarestorage.com",
    bucket: "e2e-sync",
    key: `vaults/${account}/${smallId}`,
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    expiresSeconds: 3600,
    now,
  };
  const download = presignR2Url({ ...input, method: "GET" });
  const upload = presignR2Url({ ...input, method: "PUT" });
  assert.equal(download, presignR2Url({ ...input, method: "GET" }));
  assert.notEqual(download, upload);
  const url = new URL(download);
  assert.equal(url.host, "example.r2.cloudflarestorage.com");
  assert.equal(url.pathname, `/e2e-sync/vaults/${account}/${smallId}`);
  assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "3600");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.match(url.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
  assert.match(url.searchParams.get("X-Amz-Credential") ?? "", /^access-key\/20260102\/auto\/s3\/aws4_request$/);
});

test("r2 list xml identifies vault objects", () => {
  const key = `vaults/${account}/${smallId}`;
  const xml = `<ListBucketResult><Contents><Key>${key}</Key><Size>12</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`;
  const parsed = parseListObjects(xml);
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parseObjectKey(parsed.keys[0]?.key ?? ""), { accountId: account, fileId: smallId });
  assert.equal(parsed.keys[0]?.size, 12);
});
