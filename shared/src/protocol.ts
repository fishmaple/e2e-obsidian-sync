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
}

export interface Manifest {
  files: RemoteFile[];
}

export interface ObjectPayload {
  vault: string;
  pathCipher: PayloadCipher;
  contentCipher: PayloadCipher;
  contentMac: string;
  size: number;
  mtime: number;
  encoding: Encoding;
}

export interface VaultStat {
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
