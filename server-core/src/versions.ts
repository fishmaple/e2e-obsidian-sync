import { bytesToHex, randomBytes } from "../../shared/src/codec";
import {
  AUTO_VERSION_LIMIT_DEFAULT,
  AUTO_VERSION_LIMIT_MAX,
  AUTO_VERSION_LIMIT_MIN,
  emptyFlush,
  evaluateFlush,
  retentionView,
  type FileVersionInfo,
  type FlushWindow,
  type RetentionView,
  type SyncTrigger,
  type VersionKind,
} from "../../shared/src/history";
import { MAX_BODY_BYTES, MAX_FILE_BYTES, type Encoding, type PayloadCipher } from "../../shared/src/protocol";
import type { FileVersionRow, HistoryWriteResult, ObjectRow, SyncDb } from "./db";
import { HttpError } from "./http-error";
import type { BlobStore } from "./storage";

export interface HistoryWriteOptions {
  syncTrigger: SyncTrigger;
  autoLimit?: number;
  /** Undefined leaves the stored manual cap unchanged. Null clears it. */
  manualLimit?: number | null;
  /**
   * `checkpoint` stores a full envelope in object storage (legacy clients, manual,
   * restore, and the first revision). `delta` stores only a sealed patch in the
   * database. Missing kind on the wire is a checkpoint so older plugins keep working.
   */
  kind: VersionKind;
  patchCipher?: PayloadCipher;
}

const VERSION_ID = /^[0-9a-f]{64}$/;

export function parseHistoryOptions(value: unknown, encoding: Encoding, requireEncryption: boolean): HistoryWriteOptions {
  if (!value || typeof value !== "object") return { syncTrigger: "auto", kind: "checkpoint" };
  const body = value as {
    syncTrigger?: unknown;
    sync_trigger?: unknown;
    autoLimit?: unknown;
    auto_limit?: unknown;
    manualLimit?: unknown;
    manual_limit?: unknown;
    historyKind?: unknown;
    history_kind?: unknown;
    patchCipher?: unknown;
    patch_cipher?: unknown;
  };
  const triggerRaw = body.syncTrigger !== undefined ? body.syncTrigger : body.sync_trigger;
  let syncTrigger: SyncTrigger = "auto";
  if (triggerRaw !== undefined) {
    if (triggerRaw !== "auto" && triggerRaw !== "manual" && triggerRaw !== "restore") {
      throw new HttpError(400, "Invalid sync trigger");
    }
    syncTrigger = triggerRaw;
  }
  const limits = {
    autoLimit: parseAutoLimit(body.autoLimit !== undefined ? body.autoLimit : body.auto_limit),
    manualLimit: parseManualLimit(body, body.manualLimit !== undefined || body.manual_limit !== undefined),
  };
  const kindRaw = body.historyKind !== undefined ? body.historyKind : body.history_kind;
  if (kindRaw === undefined || syncTrigger !== "auto") return { syncTrigger, kind: "checkpoint", ...limits };
  if (kindRaw === "checkpoint") return { syncTrigger, kind: "checkpoint", ...limits };
  if (kindRaw !== "delta") throw new HttpError(400, "Invalid history kind");
  const patch = parsePatchCipher(body.patchCipher !== undefined ? body.patchCipher : body.patch_cipher, encoding, requireEncryption);
  return { syncTrigger, kind: "delta", patchCipher: patch, ...limits };
}

export function parseRetentionBody(value: unknown): { autoLimit?: number; manualLimit?: number | null } {
  if (!value || typeof value !== "object") throw new HttpError(400, "Invalid retention settings");
  const body = value as { autoLimit?: unknown; auto_limit?: unknown; manualLimit?: unknown; manual_limit?: unknown };
  const hasAuto = body.autoLimit !== undefined || body.auto_limit !== undefined;
  const hasManual = body.manualLimit !== undefined || body.manual_limit !== undefined;
  if (!hasAuto && !hasManual) throw new HttpError(400, "Invalid retention settings");
  return {
    autoLimit: hasAuto ? parseAutoLimit(body.autoLimit !== undefined ? body.autoLimit : body.auto_limit, true) : undefined,
    manualLimit: parseManualLimit(body, hasManual),
  };
}

export interface CheckpointUpload {
  contentCipher: PayloadCipher;
  contentMac: string;
  size: number;
  mtime: number;
  encoding: Encoding;
  tipRev: number;
  syncTrigger: SyncTrigger;
}

export function parseCheckpointUpload(value: unknown, requireEncryption: boolean): CheckpointUpload {
  if (!value || typeof value !== "object") throw new HttpError(400, "Invalid checkpoint");
  const body = value as {
    contentCipher?: unknown;
    contentMac?: unknown;
    size?: unknown;
    mtime?: unknown;
    encoding?: unknown;
    tipRev?: unknown;
    tip_rev?: unknown;
    syncTrigger?: unknown;
    sync_trigger?: unknown;
  };
  if (typeof body.contentMac !== "string" || !/^[0-9a-f]{64}$/.test(body.contentMac)) {
    throw new HttpError(400, "Invalid content fingerprint");
  }
  if (body.encoding !== "e2ee" && body.encoding !== "plain") throw new HttpError(400, "Invalid encryption flag");
  if (requireEncryption && body.encoding !== "e2ee") throw new HttpError(400, "The server requires encryption and rejected plaintext");
  if (typeof body.size !== "number" || !Number.isInteger(body.size) || body.size < 0 || body.size > MAX_FILE_BYTES) {
    throw new HttpError(400, "Invalid file size");
  }
  if (typeof body.mtime !== "number" || !Number.isFinite(body.mtime)) throw new HttpError(400, "Invalid modification time");
  const tipRaw = body.tipRev !== undefined ? body.tipRev : body.tip_rev;
  if (typeof tipRaw !== "number" || !Number.isSafeInteger(tipRaw) || tipRaw < 1) throw new HttpError(400, "Invalid tip revision");
  const triggerRaw = body.syncTrigger !== undefined ? body.syncTrigger : body.sync_trigger;
  let syncTrigger: SyncTrigger = "auto";
  if (triggerRaw !== undefined) {
    if (triggerRaw !== "auto" && triggerRaw !== "manual" && triggerRaw !== "restore") {
      throw new HttpError(400, "Invalid sync trigger");
    }
    syncTrigger = triggerRaw;
  }
  const contentCipher = parsePatchCipher(body.contentCipher, body.encoding, requireEncryption);
  return {
    contentCipher,
    contentMac: body.contentMac,
    size: body.size,
    mtime: body.mtime,
    encoding: body.encoding,
    tipRev: tipRaw,
    syncTrigger,
  };
}

export function assertVersionId(versionId: string): void {
  if (!VERSION_ID.test(versionId)) throw new HttpError(400, "Invalid version id");
}

export function toVersionInfo(row: FileVersionRow): FileVersionInfo {
  return {
    versionId: row.versionId,
    fileId: row.fileId,
    createdAt: row.createdAt,
    size: row.size,
    mtime: row.mtime,
    encoding: row.encoding,
    tipRev: row.tipRev,
    syncTrigger: row.syncTrigger,
    contentMac: row.contentMac,
    kind: row.kind,
    baseVersionId: row.baseVersionId,
    sealed: row.sealed,
    foldedInto: row.foldedInto,
    patchBytes: row.patchBytes,
  };
}

export function historyResponse(history: HistoryWriteResult): {
  versionId?: string;
  historyKind?: VersionKind;
  flush: FlushWindow;
} {
  return {
    ...(history.versionId ? { versionId: history.versionId } : {}),
    ...(history.historyKind ? { historyKind: history.historyKind } : {}),
    flush: history.flush,
  };
}

export async function retentionFor(db: SyncDb, accountId: string, fileId: string): Promise<RetentionView> {
  const stored = await db.getRetention(accountId, fileId);
  return retentionView(stored?.autoLimit ?? AUTO_VERSION_LIMIT_DEFAULT, stored?.manualLimit ?? null);
}

/**
 * Record history for a tip that was just written.
 * Deltas keep their patch in the database. Checkpoints copy the tip envelope into
 * the object-store history key, then delete patch bodies of deltas they cover.
 * Version rows stay so the day list can still count those edits.
 */
export function recordHistory(db: SyncDb, blobs: BlobStore, options: HistoryWriteOptions): (row: ObjectRow) => Promise<HistoryWriteResult> {
  return async (row) => {
    const autoLimit = await rememberLimits(db, row.accountId, row.fileId, options);
    const head = await db.latestFileVersion(row.accountId, row.fileId);
    const canDelta = options.kind === "delta" && options.patchCipher && head && await db.hasCheckpoint(row.accountId, row.fileId);
    if (canDelta && options.patchCipher) {
      return writeDelta(db, row, options.patchCipher, head, autoLimit);
    }
    return writeCheckpointFromTip(db, blobs, row, options.syncTrigger, head?.versionId ?? "", autoLimit);
  };
}

/**
 * Store a client-uploaded full envelope as a checkpoint for the current tip.
 * A repeat of the same tip revision returns the checkpoint already recorded.
 */
export async function storeUploadedCheckpoint(
  db: SyncDb,
  blobs: BlobStore,
  row: ObjectRow,
  syncTrigger: SyncTrigger,
  body: string,
  autoLimit: number,
): Promise<HistoryWriteResult> {
  const latest = await db.latestFileVersion(row.accountId, row.fileId);
  if (latest && latest.kind === "checkpoint" && latest.tipRev === row.rev && latest.contentMac === row.contentMac) {
    await db.sealPendingDeltas(row.accountId, row.fileId, latest.versionId);
    return {
      droppedVersionIds: [],
      versionId: latest.versionId,
      historyKind: "checkpoint",
      flush: evaluateFlush(await db.listPendingDeltaStats(row.accountId, row.fileId), Date.now()),
    };
  }
  const versionId = bytesToHex(randomBytes(32));
  await blobs.putVersion(row.accountId, versionId, body);
  try {
    const written = await db.finishCheckpoint({
      accountId: row.accountId,
      versionId,
      fileId: row.fileId,
      vaultName: row.vaultName,
      pathCipher: row.pathCipher,
      contentMac: row.contentMac,
      size: row.size,
      mtime: row.mtime,
      createdAt: Date.now(),
      encoding: row.encoding,
      tipRev: row.rev,
      syncTrigger,
      kind: "checkpoint",
      baseVersionId: latest?.versionId ?? "",
      sealed: false,
      foldedInto: "",
      patchBytes: 0,
    }, autoLimit);
    if (written.versionId !== versionId) {
      try {
        await blobs.deleteVersion(row.accountId, versionId);
      } catch (cleanup) {
        console.error("Failed to remove a duplicate checkpoint blob", cleanup);
      }
    }
    return written;
  } catch (error) {
    try {
      await blobs.deleteVersion(row.accountId, versionId);
    } catch (cleanup) {
      console.error("Failed to remove a checkpoint blob after a database error", cleanup);
    }
    throw error;
  }
}

export async function forgetVersionBlobs(blobs: BlobStore, accountId: string, versionIds: string[]): Promise<void> {
  for (const versionId of versionIds) {
    try {
      await blobs.deleteVersion(accountId, versionId);
    } catch (error) {
      console.error("Failed to delete a trimmed version blob", error);
    }
  }
}

async function writeDelta(
  db: SyncDb,
  row: ObjectRow,
  patchCipher: PayloadCipher,
  head: FileVersionRow,
  autoLimit: number,
): Promise<HistoryWriteResult> {
  const versionId = bytesToHex(randomBytes(32));
  const patchJson = JSON.stringify(patchCipher);
  await db.insertFileVersion({
    accountId: row.accountId,
    versionId,
    fileId: row.fileId,
    vaultName: row.vaultName,
    pathCipher: row.pathCipher,
    contentMac: row.contentMac,
    size: row.size,
    mtime: row.mtime,
    createdAt: row.updatedAt,
    encoding: row.encoding,
    tipRev: row.rev,
    syncTrigger: "auto",
    kind: "delta",
    baseVersionId: head.versionId,
    sealed: false,
    foldedInto: "",
    patchBytes: Buffer.byteLength(patchJson),
  });
  await db.putPatch(row.accountId, versionId, patchJson);
  const droppedVersionIds = await db.dropExcessHistory(row.accountId, row.fileId, autoLimit);
  return {
    droppedVersionIds,
    versionId,
    historyKind: "delta",
    flush: evaluateFlush(await db.listPendingDeltaStats(row.accountId, row.fileId), Date.now()),
  };
}

async function writeCheckpointFromTip(
  db: SyncDb,
  blobs: BlobStore,
  row: ObjectRow,
  syncTrigger: SyncTrigger,
  baseVersionId: string,
  autoLimit: number,
): Promise<HistoryWriteResult> {
  const versionId = bytesToHex(randomBytes(32));
  const json = await blobs.get(row.accountId, row.fileId);
  await blobs.putVersion(row.accountId, versionId, json);
  await db.insertFileVersion({
    accountId: row.accountId,
    versionId,
    fileId: row.fileId,
    vaultName: row.vaultName,
    pathCipher: row.pathCipher,
    contentMac: row.contentMac,
    size: row.size,
    mtime: row.mtime,
    createdAt: row.updatedAt,
    encoding: row.encoding,
    tipRev: row.rev,
    syncTrigger,
    kind: "checkpoint",
    baseVersionId,
    sealed: false,
    foldedInto: "",
    patchBytes: 0,
  });
  await db.sealPendingDeltas(row.accountId, row.fileId, versionId);
  const droppedVersionIds = await db.dropExcessHistory(row.accountId, row.fileId, autoLimit);
  return { droppedVersionIds, versionId, historyKind: "checkpoint", flush: emptyFlush() };
}

async function rememberLimits(db: SyncDb, accountId: string, fileId: string, options: HistoryWriteOptions): Promise<number> {
  const stored = await db.getRetention(accountId, fileId);
  const autoLimit = options.autoLimit ?? stored?.autoLimit ?? AUTO_VERSION_LIMIT_DEFAULT;
  if (options.autoLimit !== undefined || options.manualLimit !== undefined) {
    await db.saveRetention(accountId, fileId, autoLimit, options.manualLimit);
  }
  return autoLimit;
}

function parsePatchCipher(value: unknown, encoding: Encoding, requireEncryption: boolean): PayloadCipher {
  if (!value || typeof value !== "object") throw new HttpError(400, "Invalid history patch");
  const record = value as { v?: unknown; iv?: unknown; ct?: unknown; raw?: unknown };
  if (record.v === 0) {
    if (requireEncryption || encoding !== "plain") throw new HttpError(400, "Invalid history patch");
    if (typeof record.raw !== "string" || record.raw.length > MAX_BODY_BYTES) throw new HttpError(400, "Invalid history patch");
    return { v: 0, raw: record.raw };
  }
  if (encoding !== "e2ee" || record.v !== 1 || typeof record.iv !== "string" || typeof record.ct !== "string") {
    throw new HttpError(400, "Invalid history patch");
  }
  if (record.iv.length > 64 || record.ct.length > MAX_BODY_BYTES) throw new HttpError(413, "Ciphertext is too large");
  return { v: 1, iv: record.iv, ct: record.ct };
}

function parseAutoLimit(value: unknown, required = false): number | undefined {
  if (value === undefined) {
    if (required) throw new HttpError(400, "Invalid auto version limit");
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < AUTO_VERSION_LIMIT_MIN || value > AUTO_VERSION_LIMIT_MAX) {
    throw new HttpError(400, "Invalid auto version limit");
  }
  return value;
}

function parseManualLimit(
  body: { manualLimit?: unknown; manual_limit?: unknown },
  present: boolean,
): number | null | undefined {
  if (!present) return undefined;
  const raw = body.manualLimit !== undefined ? body.manualLimit : body.manual_limit;
  if (raw === null) return null;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= AUTO_VERSION_LIMIT_MIN && raw <= AUTO_VERSION_LIMIT_MAX) {
    return raw;
  }
  throw new HttpError(400, "Invalid manual version limit");
}
