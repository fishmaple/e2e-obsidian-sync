/**
 * Byte patches for incremental history.
 *
 * The client diffs plaintext, then seals the patch bytes with the same envelope
 * as a note body (AAD `patch:<fileId>`). The server stores that ciphertext and
 * never inspects it. Applying a patch is the inverse, after the device decrypts.
 */

const BLOCK = 16;
const MAGIC = [0x45, 0x50, 0x31, 0x00] as const;

type Op =
  | { t: "copy"; from: number; len: number }
  | { t: "insert"; data: Uint8Array };

export function patchAad(fileId: string): string {
  return `patch:${fileId}`;
}

export function bodyAad(fileId: string): string {
  return `body:${fileId}`;
}

export function diffBytes(base: Uint8Array, next: Uint8Array): Uint8Array {
  if (bytesEqual(base, next)) return encode([]);
  const candidates = [prefixSuffixOps(base, next), blockOps(base, next)];
  let best = encode([{ t: "insert", data: next }]);
  for (const ops of candidates) {
    if (!ops) continue;
    const encoded = encode(ops);
    if (encoded.byteLength < best.byteLength) best = encoded;
  }
  if (!bytesEqual(applyPatch(base, best), next)) best = encode([{ t: "insert", data: next }]);
  return best;
}

export function applyPatch(base: Uint8Array, patch: Uint8Array): Uint8Array {
  const ops = decode(patch);
  if (ops.length === 0) return base.slice();
  let total = 0;
  const parts: Uint8Array[] = [];
  for (const op of ops) {
    if (op.t === "copy") {
      if (op.from < 0 || op.len < 0 || op.from + op.len > base.length) {
        throw new Error("Patch copy is outside the base");
      }
      parts.push(base.subarray(op.from, op.from + op.len));
      total += op.len;
      continue;
    }
    parts.push(op.data);
    total += op.data.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function prefixSuffixOps(base: Uint8Array, next: Uint8Array): Op[] {
  let prefix = 0;
  const limit = Math.min(base.length, next.length);
  while (prefix < limit && base[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < limit - prefix
    && base[base.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }
  const ops: Op[] = [];
  if (prefix > 0) ops.push({ t: "copy", from: 0, len: prefix });
  const middle = next.length - suffix - prefix;
  if (middle > 0) ops.push({ t: "insert", data: next.subarray(prefix, prefix + middle) });
  if (suffix > 0) ops.push({ t: "copy", from: base.length - suffix, len: suffix });
  return ops;
}

function blockOps(base: Uint8Array, next: Uint8Array): Op[] | null {
  if (base.length < BLOCK || next.length < BLOCK) return null;
  const index = new Map<string, number>();
  for (let offset = 0; offset + BLOCK <= base.length; offset += BLOCK) {
    const key = keyOf(base, offset);
    if (!index.has(key)) index.set(key, offset);
  }
  const ops: Op[] = [];
  let pos = 0;
  let literalAt = 0;
  while (pos < next.length) {
    if (pos + BLOCK <= next.length) {
      const at = index.get(keyOf(next, pos));
      if (at !== undefined && regionEqual(base, at, next, pos, BLOCK)) {
        let len = BLOCK;
        while (at + len < base.length && pos + len < next.length && base[at + len] === next[pos + len]) len++;
        if (pos > literalAt) ops.push({ t: "insert", data: next.subarray(literalAt, pos) });
        ops.push({ t: "copy", from: at, len });
        pos += len;
        literalAt = pos;
        continue;
      }
    }
    pos++;
  }
  if (literalAt < next.length) ops.push({ t: "insert", data: next.subarray(literalAt) });
  return ops;
}

function encode(ops: readonly Op[]): Uint8Array {
  let size = MAGIC.length;
  for (const op of ops) size += op.t === "copy" ? 9 : 5 + op.data.byteLength;
  const out = new Uint8Array(size);
  out.set(MAGIC, 0);
  let offset: number = MAGIC.length;
  for (const op of ops) {
    if (op.t === "copy") {
      out[offset++] = 1;
      offset = writeU32(out, offset, op.from);
      offset = writeU32(out, offset, op.len);
      continue;
    }
    out[offset++] = 2;
    offset = writeU32(out, offset, op.data.byteLength);
    out.set(op.data, offset);
    offset += op.data.byteLength;
  }
  return out;
}

function decode(patch: Uint8Array): Op[] {
  if (patch.length < MAGIC.length || MAGIC.some((byte, index) => patch[index] !== byte)) {
    throw new Error("Unsupported patch");
  }
  const ops: Op[] = [];
  let offset = MAGIC.length;
  while (offset < patch.length) {
    const tag = patch[offset++];
    if (tag === 1) {
      const from = readU32(patch, offset);
      offset += 4;
      const len = readU32(patch, offset);
      offset += 4;
      ops.push({ t: "copy", from, len });
      continue;
    }
    if (tag === 2) {
      const len = readU32(patch, offset);
      offset += 4;
      if (offset + len > patch.length) throw new Error("Patch insert is truncated");
      ops.push({ t: "insert", data: patch.slice(offset, offset + len) });
      offset += len;
      continue;
    }
    throw new Error("Unsupported patch");
  }
  return ops;
}

function keyOf(bytes: Uint8Array, offset: number): string {
  let key = "";
  for (let i = 0; i < BLOCK; i++) key += String.fromCharCode(bytes[offset + i] ?? 0);
  return key;
}

function regionEqual(left: Uint8Array, leftAt: number, right: Uint8Array, rightAt: number, len: number): boolean {
  for (let i = 0; i < len; i++) {
    if (left[leftAt + i] !== right[rightAt + i]) return false;
  }
  return true;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function writeU32(out: Uint8Array, offset: number, value: number): number {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
  out[offset + 2] = (value >>> 16) & 0xff;
  out[offset + 3] = (value >>> 24) & 0xff;
  return offset + 4;
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new Error("Patch is truncated");
  return (bytes[offset] ?? 0)
    | ((bytes[offset + 1] ?? 0) << 8)
    | ((bytes[offset + 2] ?? 0) << 16)
    | ((bytes[offset + 3] ?? 0) << 24);
}
