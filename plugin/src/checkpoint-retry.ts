/**
 * Checkpoint writes happen after the tip is stored. A failed write is remembered
 * by file id so the next sync can upload that tip again. A newer tip replaces
 * the older retry for the same file.
 */

export interface CheckpointRetry {
  fileId: string;
  tipRev: number;
  contentMac: string;
  size: number;
  mtime: number;
  encoding: "e2ee" | "plain";
  syncTrigger: "auto" | "manual" | "restore";
}

export interface CheckpointFlushCounts {
  flushed: number;
  skippedDiverged: number;
  skippedTipMoved: number;
  failed: number;
}

const HEX_64 = /^[0-9a-f]{64}$/;

export function emptyCheckpointCounts(): CheckpointFlushCounts {
  return { flushed: 0, skippedDiverged: 0, skippedTipMoved: 0, failed: 0 };
}

export function checkpointCountsMatter(counts: CheckpointFlushCounts): boolean {
  return counts.flushed + counts.skippedDiverged + counts.skippedTipMoved + counts.failed > 0;
}

/** 409 because the tip moved is quiet. Anything else is a visible failure. */
export function checkpointFailureKind(error: unknown): "skippedTipMoved" | "failed" {
  if (!error || typeof error !== "object") return "failed";
  const record = error as { name?: unknown; reason?: unknown; status?: unknown };
  if (record.name === "SyncConflictError" && record.status === 409 && record.reason === "parent_rev") {
    return "skippedTipMoved";
  }
  return "failed";
}

export function rememberCheckpointRetry(
  queue: Record<string, CheckpointRetry>,
  retry: CheckpointRetry,
): Record<string, CheckpointRetry> {
  return { ...queue, [retry.fileId]: retry };
}

export function forgetCheckpointRetry(
  queue: Record<string, CheckpointRetry>,
  fileId: string,
): Record<string, CheckpointRetry> {
  if (!(fileId in queue)) return queue;
  const next = { ...queue };
  delete next[fileId];
  return next;
}

export function normalizeCheckpointRetries(value: unknown): Record<string, CheckpointRetry> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, CheckpointRetry> = {};
  for (const [fileId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!HEX_64.test(fileId) || !raw || typeof raw !== "object") continue;
    const row = raw as Partial<CheckpointRetry>;
    if (row.fileId !== fileId) continue;
    if (typeof row.tipRev !== "number" || !Number.isSafeInteger(row.tipRev) || row.tipRev < 1) continue;
    if (typeof row.contentMac !== "string" || !HEX_64.test(row.contentMac)) continue;
    if (typeof row.size !== "number" || !Number.isInteger(row.size) || row.size < 0) continue;
    if (typeof row.mtime !== "number" || !Number.isFinite(row.mtime)) continue;
    if (row.encoding !== "e2ee" && row.encoding !== "plain") continue;
    if (row.syncTrigger !== "auto" && row.syncTrigger !== "manual" && row.syncTrigger !== "restore") continue;
    out[fileId] = {
      fileId,
      tipRev: row.tipRev,
      contentMac: row.contentMac,
      size: row.size,
      mtime: row.mtime,
      encoding: row.encoding,
      syncTrigger: row.syncTrigger,
    };
  }
  return out;
}
