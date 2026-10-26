/** Used when host is left empty. Change this after the public server is deployed. */
export const PUBLIC_SERVER_HOST = "https://e2e.fishmaple.cn";

export const PROTOCOL_VERSION = 1;
export const MIN_SECRET_LENGTH = 16;
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_BODY_BYTES = 48 * 1024 * 1024;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const DEVICE_TTL_MS = 5 * 60 * 1000;
export const PAIRING_TTL_MS = 10 * 60 * 1000;

export const HEADER_ACCOUNT = "x-account-id";
export const HEADER_TIMESTAMP = "x-timestamp";
export const HEADER_SIGNATURE = "x-signature";
export const HEADER_BODY_SHA256 = "x-content-sha256";

export interface Envelope {
  v: 1;
  iv: string;
  ct: string;
}

export interface PlainEnvelope {
  v: 0;
  raw: string;
}

export type PayloadCipher = Envelope | PlainEnvelope;
export type Encoding = "e2ee" | "plain";

export interface RemoteFile {
  fileId: string;
  contentMac: string;
  size: number;
  mtime: number;
  updatedAt: number;
  encoding: Encoding;
  /**
   * Monotonic per-file revision. Missing or 0 means the server did not report one
   * (older servers). New servers start at 1.
   */
  rev?: number;
}

export interface Manifest {
  files: RemoteFile[];
  /** Vault change-log head. Older servers omit this. */
  cursor?: number;
}

export interface ObjectPayload {
  vault: string;
  vaultId?: string;
  pathCipher: PayloadCipher;
  contentCipher: PayloadCipher;
  contentMac: string;
  size: number;
  mtime: number;
  encoding: Encoding;
  /**
   * Revision this device last synced for the file.
   * Null or omitted means first upload / unknown.
   * JSON may use `parentRev` (canonical, same style as contentMac) or `parent_rev`.
   */
  parentRev?: number | null;
}

export interface PutResult {
  ok: true;
  rev: number;
  contentMac: string;
  mtime: number;
  encoding: Encoding;
  size: number;
  updatedAt: number;
}

export type ChangeOp = "upsert" | "delete";

export interface ChangeEntry {
  seq: number;
  op: ChangeOp;
  fileId: string;
  rev: number;
  contentMac: string;
  size: number;
  mtime: number;
  updatedAt: number;
  encoding: Encoding;
}

export interface ChangesResponse {
  since: number;
  cursor: number;
  more: boolean;
  changes: ChangeEntry[];
}

export interface ConflictBody {
  error: string;
  reason: "parent_rev" | "deleted";
  file: RemoteFile | null;
}

export interface SignedTransfer {
  fileId: string;
  url: string;
  expiresAt: number;
}

export interface DownloadUrl extends SignedTransfer {
  pathCipher: PayloadCipher;
  contentMac: string;
  size: number;
  mtime: number;
  updatedAt: number;
  encoding: Encoding;
  rev: number;
}

export interface UrlConflict {
  fileId: string;
  reason: "parent_rev" | "deleted";
  file: RemoteFile | null;
}

export interface UrlListResponse {
  downloads: DownloadUrl[];
  uploads: SignedTransfer[];
  conflicts: UrlConflict[];
  missing: string[];
}

/** Positive integer revision, or 0 when the server did not send one. */
export function remoteRev(file: { rev?: unknown }): number {
  const rev = file.rev;
  return typeof rev === "number" && Number.isSafeInteger(rev) && rev > 0 ? rev : 0;
}

export interface VaultStat {
  id: string;
  name: string;
  files: number;
  bytes: number;
  lastSyncAt: number;
  encrypted: boolean;
}

export function canonicalString(method: string, path: string, timestamp: string, bodyHash: string): string {
  return `${timestamp}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
}

export function normalizeHost(input: string): string {
  const trimmed = input.trim();
  const raw = trimmed || PUBLIC_SERVER_HOST;
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error("Server address must start with http:// or https://");
  }
  return new URL(raw).origin;
}

export function isPlaceholderHost(host: string): boolean {
  return normalizeHost(host) === new URL(PUBLIC_SERVER_HOST).origin;
}
