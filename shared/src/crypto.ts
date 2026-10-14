import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from "./codec";
import { canonicalString, type Envelope, type PayloadCipher, HEADER_ACCOUNT, HEADER_BODY_SHA256, HEADER_SIGNATURE, HEADER_TIMESTAMP } from "./protocol";

const PROTOCOL_SALT = "obsidian-e2ee-sync-v1";
const encoder = new TextEncoder();

type SymmetricKey = Awaited<ReturnType<SubtleCrypto["importKey"]>>;

function source(data: Uint8Array): BufferSource {
  return data as BufferSource;
}

export interface DerivedKeys {
  encKey: SymmetricKey;
  authKey: SymmetricKey;
  authKeyRaw: Uint8Array;
  idKey: SymmetricKey;
}

export async function deriveKeys(secret: string): Promise<DerivedKeys> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey", "deriveBits"]);
  const salt = encoder.encode(PROTOCOL_SALT);
  const encKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("enc") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const authBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("auth") },
    material,
    256,
  );
  const authKeyRaw = new Uint8Array(authBits);
  const authKey = await importHmacKey(authKeyRaw);
  const idBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("id") },
    material,
    256,
  );
  const idKey = await importHmacKey(new Uint8Array(idBits));
  return { encKey, authKey, authKeyRaw, idKey };
}

export function importHmacKey(raw: Uint8Array): Promise<SymmetricKey> {
  return crypto.subtle.importKey("raw", source(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function encryptBytes(key: SymmetricKey, data: Uint8Array, aad: string): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    source(data),
  );
  return { v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
}

export async function sealBytes(key: SymmetricKey, data: Uint8Array, aad: string, encrypt: boolean): Promise<PayloadCipher> {
  if (!encrypt) return { v: 0, raw: bytesToBase64(data) };
  return encryptBytes(key, data, aad);
}

export async function openBytes(key: SymmetricKey | null, payload: PayloadCipher, aad: string): Promise<Uint8Array> {
  if (payload.v === 0) return base64ToBytes(payload.raw);
  if (!key) throw new Error("A key is required to open encrypted notes");
  return decryptBytes(key, payload, aad);
}

export async function decryptBytes(key: SymmetricKey, envelope: Envelope, aad: string): Promise<Uint8Array> {
  if (envelope.v !== 1) throw new Error("Unsupported ciphertext version");
  const iv = base64ToBytes(envelope.iv);
  const ct = base64ToBytes(envelope.ct);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: source(iv), additionalData: encoder.encode(aad) },
      key,
      source(ct),
    );
    return new Uint8Array(plain);
  } catch {
    throw new Error("Decryption failed. The key does not match the backup on the server");
  }
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", source(data));
  return bytesToHex(new Uint8Array(digest));
}

export async function contentMac(idKey: SymmetricKey, plaintext: Uint8Array): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", idKey, source(plaintext));
  return bytesToHex(new Uint8Array(mac));
}

export async function plainFileId(vault: string, path: string): Promise<string> {
  return sha256Hex(encoder.encode(`plain\nvault\n${vault}\npath\n${path}`));
}

export async function plainMac(plaintext: Uint8Array): Promise<string> {
  return sha256Hex(plaintext);
}

export async function fileIdForPath(idKey: SymmetricKey, path: string, vault = ""): Promise<string> {
  const label = vault ? `vault\n${vault}\npath\n${path}` : `path\n${path}`;
  const mac = await crypto.subtle.sign("HMAC", idKey, encoder.encode(label));
  return bytesToHex(new Uint8Array(mac));
}

export async function signRequest(
  authKey: SymmetricKey,
  input: { method: string; path: string; body: Uint8Array; accountId: string; timestamp?: string },
): Promise<Record<string, string>> {
  const timestamp = input.timestamp ?? Date.now().toString();
  const bodyHash = await sha256Hex(input.body);
  const signature = await crypto.subtle.sign(
    "HMAC",
    authKey,
    encoder.encode(canonicalString(input.method, input.path, timestamp, bodyHash)),
  );
  return {
    [HEADER_ACCOUNT]: input.accountId,
    [HEADER_TIMESTAMP]: timestamp,
    [HEADER_BODY_SHA256]: bodyHash,
    [HEADER_SIGNATURE]: bytesToHex(new Uint8Array(signature)),
    "content-type": "application/json; charset=utf-8",
  };
}

export async function verifySignature(
  authKeyRaw: Uint8Array,
  input: { method: string; path: string; body: Uint8Array; timestamp: string; signatureHex: string },
): Promise<boolean> {
  const key = await importHmacKey(authKeyRaw);
  const bodyHash = await sha256Hex(input.body);
  const data = encoder.encode(canonicalString(input.method, input.path, input.timestamp, bodyHash));
  return crypto.subtle.verify("HMAC", key, source(hexToBytes(input.signatureHex)), data);
}
