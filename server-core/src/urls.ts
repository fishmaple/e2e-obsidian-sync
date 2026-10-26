import { createHmac, timingSafeEqual } from "node:crypto";
import {
  MAX_BODY_BYTES,
  type DownloadUrl,
  type Encoding,
  type PayloadCipher,
  type RemoteFile,
  type SignedTransfer,
  type UrlConflict,
  type UrlListResponse,
} from "../../shared/src/protocol";
import type { AppConfig } from "./config";
import type { ObjectRow, SyncDb } from "./db";
import { HttpError } from "./http-error";
import { R2Client } from "./r2";
import { storedBytes, type BlobStore } from "./storage";

export const URL_TTL_MS = 60 * 60 * 1000;
export const URL_LIST_LIMIT = 200;
const FILE_ID = /^[0-9a-f]{64}$/;

export async function listTransferUrls(input: {
  config: AppConfig;
  db: SyncDb;
  accountId: string;
  vaultName: string;
  origin: string;
  downloads: string[];
  uploads: { fileId: string; parentRev: number | null; bytes: number }[];
  now?: number;
}): Promise<UrlListResponse> {
  if (input.downloads.length > URL_LIST_LIMIT || input.uploads.length > URL_LIST_LIMIT) {
    throw new HttpError(400, "Too many files in one URL list");
  }
  const now = input.now ?? Date.now();
  const downloads: DownloadUrl[] = [];
  const missing: string[] = [];
  for (const fileId of input.downloads) {
    if (!FILE_ID.test(fileId)) throw new HttpError(400, "Invalid file ID");
    const row = await input.db.findObject(input.accountId, fileId);
    if (!row || row.vaultName !== input.vaultName) {
      missing.push(fileId);
      continue;
    }
    const link = await downloadLink(input.config, input.db, input.accountId, fileId, input.origin, now);
    downloads.push({
      ...link,
      pathCipher: JSON.parse(row.pathCipher) as PayloadCipher,
      contentMac: row.contentMac,
      size: row.size,
      mtime: row.mtime,
      updatedAt: row.updatedAt,
      encoding: row.encoding,
      rev: row.rev,
    });
  }
  const uploads: SignedTransfer[] = [];
  const conflicts: UrlConflict[] = [];
  for (const item of input.uploads) {
    if (!FILE_ID.test(item.fileId)) throw new HttpError(400, "Invalid file ID");
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > MAX_BODY_BYTES) {
      throw new HttpError(400, "Invalid upload size");
    }
    const existing = await input.db.findObject(input.accountId, item.fileId);
    if (existing && existing.vaultName !== input.vaultName) {
      conflicts.push({ fileId: item.fileId, reason: "parent_rev", file: remoteFile(existing) });
      continue;
    }
    if (!existing) {
      if (item.parentRev !== null) {
        conflicts.push({ fileId: item.fileId, reason: "deleted", file: null });
        continue;
      }
    } else if (item.parentRev === null || item.parentRev !== existing.rev) {
      conflicts.push({ fileId: item.fileId, reason: "parent_rev", file: remoteFile(existing) });
      continue;
    }
    uploads.push(await uploadLink(input.config, input.db, input.accountId, item.fileId, item.bytes, input.origin, now));
  }
  return { downloads, uploads, conflicts, missing };
}

export function directRequestValid(
  secret: string,
  method: string,
  accountId: string,
  fileId: string,
  expRaw: string,
  sig: string,
  now = Date.now(),
): boolean {
  if (!/^\d+$/.test(expRaw) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || exp < now || exp > now + URL_TTL_MS + 5 * 60 * 1000) return false;
  const expected = directSignature(secret, method, accountId, fileId, exp);
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export async function acceptServerUpload(
  config: AppConfig,
  db: SyncDb,
  accountId: string,
  fileId: string,
  body: Buffer,
  now = Date.now(),
): Promise<void> {
  const grant = await freshGrant(db, accountId, fileId, now);
  if (grant.kind !== "server") throw new HttpError(400, "This upload URL does not accept a server body");
  if (body.byteLength !== grant.bytes) throw new HttpError(400, "Uploaded object size does not match");
  const text = body.toString("utf8");
  parseStoredCipher(text, config.requireEncryption);
  await db.putUploadBody(accountId, fileId, text);
}

export async function serverDownload(blobs: BlobStore, accountId: string, fileId: string): Promise<string> {
  try {
    return await blobs.get(accountId, fileId);
  } catch {
    throw new HttpError(404, "This file is not on the server");
  }
}

export async function finishUpload(
  config: AppConfig,
  db: SyncDb,
  blobs: BlobStore,
  accountId: string,
  fileId: string,
  encoding: Encoding,
  now = Date.now(),
): Promise<void> {
  const grant = await freshGrant(db, accountId, fileId, now);
  if (grant.kind === "server") {
    const body = await db.getUploadBody(accountId, fileId);
    if (body === undefined) throw new HttpError(400, "The upload has not arrived");
    if (storedBytes(body) !== grant.bytes) throw new HttpError(400, "Uploaded object size does not match");
    const cipher = parseStoredCipher(body, config.requireEncryption);
    if ((cipher.v === 0 ? "plain" : "e2ee") !== encoding) {
      throw new HttpError(400, "Ciphertext format does not match the encryption flag");
    }
    await blobs.put(accountId, fileId, body);
    await db.deleteUploadBody(accountId, fileId);
    return;
  }
  const remote = openR2(config);
  if (!remote) throw new HttpError(500, "R2 storage is not ready");
  const size = await remote.stagingSize(accountId, fileId);
  if (size === undefined) throw new HttpError(400, "The upload has not arrived");
  if (size !== grant.bytes) throw new HttpError(400, "Uploaded object size does not match");
  await remote.copyStaging(accountId, fileId);
  await db.deleteBlob(accountId, fileId);
}

export async function discardUpload(config: AppConfig, db: SyncDb, accountId: string, fileId: string): Promise<void> {
  await db.deleteUploadGrant(accountId, fileId);
  await db.deleteUploadBody(accountId, fileId);
  const remote = openR2(config);
  if (remote) await remote.deleteStaging(accountId, fileId);
}

async function downloadLink(
  config: AppConfig,
  db: SyncDb,
  accountId: string,
  fileId: string,
  origin: string,
  now: number,
): Promise<SignedTransfer> {
  const exp = now + URL_TTL_MS;
  const inline = await db.getBlob(accountId, fileId);
  const onR2 = config.storage.kind === "r2" && (inline === undefined || storedBytes(inline) >= config.storage.inlineMaxBytes);
  if (onR2) {
    const remote = openR2(config);
    if (!remote) throw new HttpError(500, "R2 storage is not ready");
    return {
      fileId,
      url: remote.presignDownload(accountId, fileId, Math.ceil(URL_TTL_MS / 1000)),
      expiresAt: exp,
    };
  }
  return { fileId, url: serverUrl(config, origin, "GET", accountId, fileId, exp), expiresAt: exp };
}

async function uploadLink(
  config: AppConfig,
  db: SyncDb,
  accountId: string,
  fileId: string,
  bytes: number,
  origin: string,
  now: number,
): Promise<SignedTransfer> {
  const exp = now + URL_TTL_MS;
  const onR2 = config.storage.kind === "r2" && bytes >= config.storage.inlineMaxBytes;
  await db.putUploadGrant(accountId, fileId, bytes, onR2 ? "r2" : "server", exp);
  if (onR2) {
    await db.deleteUploadBody(accountId, fileId);
    const remote = openR2(config);
    if (!remote) throw new HttpError(500, "R2 storage is not ready");
    return {
      fileId,
      url: remote.presignUpload(accountId, fileId, Math.ceil(URL_TTL_MS / 1000)),
      expiresAt: exp,
    };
  }
  const remote = openR2(config);
  if (remote) await remote.deleteStaging(accountId, fileId);
  return { fileId, url: serverUrl(config, origin, "PUT", accountId, fileId, exp), expiresAt: exp };
}

function serverUrl(config: AppConfig, origin: string, method: string, accountId: string, fileId: string, exp: number): string {
  const sig = directSignature(config.sessionSecret, method, accountId, fileId, exp);
  return `${origin}/api/v1/direct/${accountId}/${fileId}?exp=${exp}&sig=${sig}`;
}

function directSignature(secret: string, method: string, accountId: string, fileId: string, exp: number): string {
  return createHmac("sha256", secret).update(`${method.toUpperCase()}\n${accountId}\n${fileId}\n${exp}`).digest("hex");
}

async function freshGrant(db: SyncDb, accountId: string, fileId: string, now: number): Promise<{ bytes: number; kind: "server" | "r2"; expiresAt: number }> {
  const grant = await db.getUploadGrant(accountId, fileId);
  if (!grant || grant.expiresAt <= now) throw new HttpError(400, "The upload URL has expired");
  return grant;
}

function parseStoredCipher(text: string, requireEncryption: boolean): PayloadCipher {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid ciphertext");
  }
  if (!value || typeof value !== "object") throw new HttpError(400, "Invalid ciphertext");
  const record = value as { v?: unknown; iv?: unknown; ct?: unknown; raw?: unknown };
  if (record.v === 0) {
    if (requireEncryption) throw new HttpError(400, "The server requires encryption and rejected plaintext");
    if (typeof record.raw !== "string") throw new HttpError(400, "Invalid plaintext");
    return { v: 0, raw: record.raw };
  }
  if (record.v !== 1 || typeof record.iv !== "string" || typeof record.ct !== "string") {
    throw new HttpError(400, "Invalid ciphertext");
  }
  return { v: 1, iv: record.iv, ct: record.ct };
}

function openR2(config: AppConfig): R2Client | null {
  if (config.storage.kind !== "r2") return null;
  const { accessKeyId, secretAccessKey, endpoint, bucket } = config.storage;
  if (!accessKeyId || !secretAccessKey) return null;
  return new R2Client(endpoint, bucket, { accessKeyId, secretAccessKey });
}

function remoteFile(row: ObjectRow): RemoteFile {
  return {
    fileId: row.fileId,
    contentMac: row.contentMac,
    size: row.size,
    mtime: row.mtime,
    updatedAt: row.updatedAt,
    encoding: row.encoding,
    rev: row.rev,
  };
}
