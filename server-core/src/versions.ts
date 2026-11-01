import { bytesToHex, randomBytes } from "../../shared/src/codec";
import {
  AUTO_VERSION_LIMIT_DEFAULT,
  AUTO_VERSION_LIMIT_MAX,
  AUTO_VERSION_LIMIT_MIN,
  retentionView,
  type FileVersionInfo,
  type RetentionView,
  type SyncTrigger,
} from "../../shared/src/history";
import type { FileVersionRow, ObjectRow, SyncDb } from "./db";
import { HttpError } from "./http-error";
import type { BlobStore } from "./storage";

export interface HistoryWriteOptions {
  syncTrigger: SyncTrigger;
  autoLimit?: number;
  /** Undefined leaves the stored manual cap unchanged. Null clears it. */
  manualLimit?: number | null;
}

const VERSION_ID = /^[0-9a-f]{64}$/;

export function parseHistoryOptions(value: unknown): HistoryWriteOptions {
  if (!value || typeof value !== "object") return { syncTrigger: "auto" };
  const body = value as {
    syncTrigger?: unknown;
    sync_trigger?: unknown;
    autoLimit?: unknown;
    auto_limit?: unknown;
    manualLimit?: unknown;
    manual_limit?: unknown;
  };
  const triggerRaw = body.syncTrigger !== undefined ? body.syncTrigger : body.sync_trigger;
  let syncTrigger: "auto" | "manual" = "auto";
  if (triggerRaw !== undefined) {
    if (triggerRaw !== "auto" && triggerRaw !== "manual") throw new HttpError(400, "Invalid sync trigger");
    syncTrigger = triggerRaw;
  }
  return {
    syncTrigger,
    autoLimit: parseAutoLimit(body.autoLimit !== undefined ? body.autoLimit : body.auto_limit),
    manualLimit: parseManualLimit(body, body.manualLimit !== undefined || body.manual_limit !== undefined),
  };
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
  };
}

export async function retentionFor(db: SyncDb, accountId: string, fileId: string): Promise<RetentionView> {
  const stored = await db.getRetention(accountId, fileId);
  return retentionView(stored?.autoLimit ?? AUTO_VERSION_LIMIT_DEFAULT, stored?.manualLimit ?? null);
}

/**
 * Copy the tip blob into an immutable version while the object transaction is open.
 * Returns version ids whose rows were trimmed and whose blobs should be deleted after commit.
 * Manual and restore versions are not trimmed. `manualLimit` is stored and not applied.
 */
export function rememberVersion(db: SyncDb, blobs: BlobStore, options: HistoryWriteOptions): (row: ObjectRow) => Promise<string[]> {
  return async (row) => {
    const json = await blobs.get(row.accountId, row.fileId);
    const versionId = bytesToHex(randomBytes(32));
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
      syncTrigger: options.syncTrigger,
    });
    const stored = await db.getRetention(row.accountId, row.fileId);
    const autoLimit = options.autoLimit ?? stored?.autoLimit ?? AUTO_VERSION_LIMIT_DEFAULT;
    if (options.autoLimit !== undefined || options.manualLimit !== undefined) {
      await db.saveRetention(row.accountId, row.fileId, autoLimit, options.manualLimit);
    }
    if (options.syncTrigger !== "auto") return [];
    return db.dropExcessAutoVersions(row.accountId, row.fileId, autoLimit);
  };
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
