export type LocalBox = { v: 1; b64: string } | { v: 0; raw: string };

interface SafeStorage {
  isEncryptionAvailable: () => boolean;
  encryptString: (plain: string) => { toString: (encoding: "base64") => string };
  decryptString: (encrypted: Uint8Array) => string;
}

let cached: SafeStorage | null | undefined;

function safe(): SafeStorage | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const electron = require("electron") as {
      safeStorage?: SafeStorage;
      remote?: { safeStorage?: SafeStorage };
    };
    const candidate = electron.safeStorage ?? electron.remote?.safeStorage ?? null;
    if (!candidate?.isEncryptionAvailable?.()) return null;
    const encoded = candidate.encryptString("e2ee-sync").toString("base64");
    if (candidate.decryptString(bufferFromBase64(encoded)) !== "e2ee-sync") return null;
    cached = candidate;
  } catch {
    cached = null;
  }
  return cached;
}

function bufferFromBase64(b64: string): Uint8Array {
  const buffer = require("buffer") as { Buffer: { from: (data: string, encoding: "base64") => Uint8Array } };
  return buffer.Buffer.from(b64, "base64");
}

export function canSealSecrets(): boolean {
  return safe() !== null;
}

export function sealLocal(plain: string): LocalBox {
  const storage = safe();
  if (!storage) return { v: 0, raw: plain };
  try {
    return { v: 1, b64: storage.encryptString(plain).toString("base64") };
  } catch {
    return { v: 0, raw: plain };
  }
}

export function openLocal(box: unknown): string {
  if (!box || typeof box !== "object") return "";
  const record = box as { v?: number; b64?: string; raw?: string };
  if (record.v === 1 && typeof record.b64 === "string") {
    const storage = safe();
    if (!storage) return "";
    return storage.decryptString(bufferFromBase64(record.b64));
  }
  return typeof record.raw === "string" ? record.raw : "";
}

declare function require(moduleName: string): unknown;
