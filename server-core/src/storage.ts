import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig, QiniuConfig } from "./config";
import type { SyncDb } from "./db";
import { R2Client, resolveR2Credentials } from "./r2";

export interface BlobStore {
  put(accountId: string, fileId: string, json: string): Promise<void>;
  get(accountId: string, fileId: string): Promise<string>;
  delete(accountId: string, fileId: string): Promise<void>;
}

export async function prepareStorage(config: AppConfig): Promise<AppConfig> {
  if (config.storage.kind !== "r2") return config;
  const credentials = await resolveR2Credentials(config.storage);
  return {
    ...config,
    storage: { ...config.storage, ...credentials, apiToken: "" },
  };
}

export function createBlobStore(config: AppConfig, db: SyncDb): BlobStore {
  if (config.storage.kind === "file") return new FileBlobStore(config.dataDir);
  if (config.storage.kind === "database") return new DatabaseBlobStore(db);
  if (config.storage.kind === "qiniu") return new QiniuBlobStore(config.storage);
  if (!config.storage.accessKeyId || !config.storage.secretAccessKey) {
    throw new Error("R2 credentials are not ready");
  }
  return new HybridBlobStore(
    db,
    new R2Client(config.storage.endpoint, config.storage.bucket, config.storage),
    config.storage.inlineMaxBytes,
  );
}

export class HybridBlobStore implements BlobStore {
  constructor(
    private readonly db: SyncDb,
    private readonly remote: BlobStore,
    private readonly inlineMaxBytes: number,
  ) {}

  async put(accountId: string, fileId: string, json: string): Promise<void> {
    if (storedBytes(json) < this.inlineMaxBytes) {
      await this.db.putBlob(accountId, fileId, json);
      await this.remote.delete(accountId, fileId);
      return;
    }
    await this.remote.put(accountId, fileId, json);
    await this.db.deleteBlob(accountId, fileId);
  }

  async get(accountId: string, fileId: string): Promise<string> {
    const inline = await this.db.getBlob(accountId, fileId);
    if (inline !== undefined && storedBytes(inline) < this.inlineMaxBytes) return inline;
    try {
      return await this.remote.get(accountId, fileId);
    } catch (error) {
      if (inline !== undefined) return inline;
      throw error;
    }
  }

  async delete(accountId: string, fileId: string): Promise<void> {
    await this.db.deleteBlob(accountId, fileId);
    await this.remote.delete(accountId, fileId);
  }
}

export function storedBytes(json: string): number {
  return Buffer.byteLength(json, "utf8");
}

class FileBlobStore implements BlobStore {
  constructor(private readonly dataDir: string) {}

  private path(accountId: string, fileId: string): string {
    return join(this.dataDir, "blobs", accountId, fileId);
  }

  async put(accountId: string, fileId: string, json: string): Promise<void> {
    const path = this.path(accountId, fileId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, json);
  }

  async get(accountId: string, fileId: string): Promise<string> {
    return readFileSync(this.path(accountId, fileId), "utf8");
  }

  async delete(accountId: string, fileId: string): Promise<void> {
    rmSync(this.path(accountId, fileId), { force: true });
  }
}

class DatabaseBlobStore implements BlobStore {
  constructor(private readonly db: SyncDb) {}

  async put(accountId: string, fileId: string, json: string): Promise<void> {
    await this.db.putBlob(accountId, fileId, json);
  }

  async get(accountId: string, fileId: string): Promise<string> {
    const content = await this.db.getBlob(accountId, fileId);
    if (content === undefined) throw new Error("The database has no content for this file");
    return content;
  }

  async delete(accountId: string, fileId: string): Promise<void> {
    await this.db.deleteBlob(accountId, fileId);
  }
}

export class QiniuBlobStore implements BlobStore {
  constructor(private readonly qiniu: QiniuConfig) {}

  async put(accountId: string, fileId: string, json: string): Promise<void> {
    const key = objectKey(accountId, fileId);
    const token = qiniuUploadToken(this.qiniu, key);
    const form = new FormData();
    form.set("token", token);
    form.set("key", key);
    form.set("file", new Blob([json]), "blob.json");
    const response = await fetch(this.qiniu.uploadUrl, { method: "POST", body: form });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Qiniu upload failed (${response.status}) ${detail}`.trim());
    }
  }

  async get(accountId: string, fileId: string): Promise<string> {
    const url = qiniuDownloadUrl(this.qiniu, objectKey(accountId, fileId));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Qiniu read failed (${response.status})`);
    return response.text();
  }

  async delete(accountId: string, fileId: string): Promise<void> {
    const entry = urlSafeBase64(`${this.qiniu.bucket}:${objectKey(accountId, fileId)}`);
    const path = `/delete/${entry}`;
    const sign = urlSafeBase64(createHmac("sha1", this.qiniu.secretKey).update(`${path}\n`).digest());
    const response = await fetch(`${this.qiniu.rsUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `QBox ${this.qiniu.accessKey}:${sign}` },
    });
    if (!response.ok && response.status !== 612) {
      throw new Error(`Qiniu delete failed (${response.status})`);
    }
  }
}

export function objectKey(accountId: string, fileId: string): string {
  return `vaults/${accountId}/${fileId}`;
}

export function qiniuUploadToken(qiniu: QiniuConfig, key: string): string {
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const encoded = urlSafeBase64(JSON.stringify({ scope: `${qiniu.bucket}:${key}`, deadline }));
  const sign = urlSafeBase64(createHmac("sha1", qiniu.secretKey).update(encoded).digest());
  return `${qiniu.accessKey}:${sign}:${encoded}`;
}

export function qiniuDownloadUrl(qiniu: QiniuConfig, key: string): string {
  const base = `${qiniu.domain}/${key.split("/").map(encodeURIComponent).join("/")}`;
  if (!qiniu.privateBucket) return base;
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const url = `${base}?e=${expires}`;
  const sign = urlSafeBase64(createHmac("sha1", qiniu.secretKey).update(url).digest());
  return `${url}&token=${encodeURIComponent(`${qiniu.accessKey}:${sign}`)}`;
}

export function urlSafeBase64(value: string | Buffer): string {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}
