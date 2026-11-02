import type { Encoding, PayloadCipher } from "./protocol";

/** Auto checkpoints kept per file when a file has no saved limit. */
export const AUTO_VERSION_LIMIT_DEFAULT = 100;
export const AUTO_VERSION_LIMIT_MIN = 1;
export const AUTO_VERSION_LIMIT_MAX = 256;

/** Pending deltas that force a checkpoint. Count only autos that stored a delta. */
export const FLUSH_DELTA_COUNT = 120;
export const FLUSH_DELTA_BYTES = 1024 * 1024;
export const FLUSH_DELTA_AGE_MS = 24 * 60 * 60 * 1000;
/** Raw patch bytes above this are stored as a checkpoint so the commit body stays small. */
export const MAX_DELTA_PATCH_BYTES = 6_000_000;

export type SyncTrigger = "auto" | "manual" | "restore";
export type VersionKind = "checkpoint" | "delta";
export type FlushReason = "count" | "bytes" | "age" | "manual" | "restore";

export interface FileVersionInfo {
  versionId: string;
  fileId: string;
  createdAt: number;
  size: number;
  mtime: number;
  encoding: Encoding;
  tipRev: number;
  syncTrigger: SyncTrigger;
  contentMac: string;
  /**
   * Missing kind means a full checkpoint. Older servers only stored those.
   * `sealed` deltas have had their patch body removed after a checkpoint.
   */
  kind?: VersionKind;
  baseVersionId?: string;
  sealed?: boolean;
  foldedInto?: string;
  patchBytes?: number;
}

/**
 * Per-file retention. `manualLimit` is stored for a future cap.
 * `manualLimitEnforced` stays false until that cap is applied.
 */
export interface RetentionView {
  autoLimit: number;
  manualLimit: number | null;
  manualLimitEnforced: false;
}

export interface VersionListResponse {
  fileId: string;
  retention: RetentionView;
  versions: FileVersionInfo[];
}

export interface VersionDownload {
  fileId: string;
  versionId: string;
  url: string;
  expiresAt: number;
  pathCipher: PayloadCipher;
  contentMac: string;
  size: number;
  mtime: number;
  createdAt: number;
  encoding: Encoding;
  tipRev: number;
  syncTrigger: SyncTrigger;
  kind?: VersionKind;
  baseVersionId?: string;
  sealed?: boolean;
  foldedInto?: string;
}

export interface VersionDayGroup {
  /** Local calendar day, YYYY-MM-DD. Empty days are omitted. */
  day: string;
  count: number;
  auto: number;
  manual: number;
  restore: number;
  bytes: number;
  earliest: number;
  latest: number;
  versions: FileVersionInfo[];
}

export interface TextDiffLine {
  op: "eq" | "del" | "add";
  text: string;
}

const DIFF_LINE_CAP = 1200;

export interface PendingDeltaStat {
  size: number;
  patchBytes?: number;
  createdAt: number;
}

export interface FlushWindow {
  pendingCount: number;
  pendingBytes: number;
  earliest: number | null;
  due: boolean;
  reason: FlushReason | null;
}

export interface HistoryRetentionNode {
  versionId: string;
  createdAt: number;
  syncTrigger: SyncTrigger;
  kind?: VersionKind;
  sealed?: boolean;
  foldedInto?: string;
}

export type ReconstructPlan =
  | { mode: "full"; versionId: string }
  | { mode: "chain"; checkpointId: string; deltaIds: string[] }
  | { mode: "sealed" }
  | { mode: "missing" };

export function versionKind(version: { kind?: VersionKind }): VersionKind {
  return version.kind === "delta" ? "delta" : "checkpoint";
}

export function clampAutoVersionLimit(value: number): number {
  if (!Number.isFinite(value)) return AUTO_VERSION_LIMIT_DEFAULT;
  return Math.min(AUTO_VERSION_LIMIT_MAX, Math.max(AUTO_VERSION_LIMIT_MIN, Math.floor(value)));
}

export function emptyFlush(): FlushWindow {
  return { pendingCount: 0, pendingBytes: 0, earliest: null, due: false, reason: null };
}

/**
 * Pending window for one file. `size` is the plaintext byte length stored on
 * the delta (the same field the day list sums). Patch body bytes also count,
 * so one huge patch cannot sit in the database.
 * `force` marks the window due even when it is empty; callers that list files
 * should use `flushReasonForSync`, which forces manual only when a delta is open.
 */
export function evaluateFlush(
  pending: readonly PendingDeltaStat[],
  now: number,
  force?: "manual" | "restore" | null,
): FlushWindow {
  let pendingBytes = 0;
  let patchBytes = 0;
  let earliest: number | null = null;
  for (const item of pending) {
    pendingBytes += Number.isFinite(item.size) ? item.size : 0;
    patchBytes += Number.isFinite(item.patchBytes) ? (item.patchBytes ?? 0) : 0;
    if (earliest === null || item.createdAt < earliest) earliest = item.createdAt;
  }
  const window: FlushWindow = {
    pendingCount: pending.length,
    pendingBytes,
    earliest,
    due: false,
    reason: null,
  };
  if (force === "manual" || force === "restore") return { ...window, due: true, reason: force };
  if (pending.length >= FLUSH_DELTA_COUNT) return { ...window, due: true, reason: "count" };
  if (pendingBytes >= FLUSH_DELTA_BYTES || patchBytes >= FLUSH_DELTA_BYTES) {
    return { ...window, due: true, reason: "bytes" };
  }
  if (earliest !== null && now - earliest >= FLUSH_DELTA_AGE_MS) return { ...window, due: true, reason: "age" };
  return window;
}

/**
 * Auto sync uses the count, byte, and age thresholds.
 * A manual sync checkpoints every file that still has an unsealed delta.
 * An empty window is not due, so a manual sync does not rewrite files with no pending history.
 */
export function flushReasonForSync(
  pending: readonly PendingDeltaStat[],
  now: number,
  syncTrigger: SyncTrigger,
): FlushWindow {
  if (syncTrigger === "manual" && pending.length > 0) return evaluateFlush(pending, now, "manual");
  return evaluateFlush(pending, now);
}

/**
 * Auto sync of an existing file stores a delta. The first revision, manual
 * sync, restore, and patches too large for the commit body are checkpoints.
 */
export function planHistoryKind(input: {
  syncTrigger: SyncTrigger;
  hasParent: boolean;
  patchBytes: number | null;
}): VersionKind {
  if (input.syncTrigger !== "auto" || !input.hasParent || input.patchBytes === null) return "checkpoint";
  if (input.patchBytes > MAX_DELTA_PATCH_BYTES) return "checkpoint";
  return "delta";
}

/**
 * Auto checkpoints past the newest `autoLimit` are dropped, together with
 * sealed auto deltas that were folded into one of those checkpoints.
 * Manual and restore rows are kept. Unsealed deltas are kept until a checkpoint
 * seals them; they are the only copy of that edit.
 */
export function historyVersionsToDrop(versions: readonly HistoryRetentionNode[], autoLimit: number): string[] {
  const keep = clampAutoVersionLimit(autoLimit);
  const autoCheckpoints = versions
    .filter((version) => versionKind(version) === "checkpoint" && version.syncTrigger === "auto")
    .sort(byNewest);
  const droppedCheckpoints = autoCheckpoints.slice(keep);
  const droppedIds = new Set(droppedCheckpoints.map((version) => version.versionId));
  const folded = versions.filter((version) =>
    version.syncTrigger === "auto"
    && versionKind(version) === "delta"
    && version.sealed === true
    && typeof version.foldedInto === "string"
    && droppedIds.has(version.foldedInto),
  );
  return [...droppedCheckpoints, ...folded].map((version) => version.versionId);
}

/**
 * How to rebuild one version on the client.
 * A checkpoint is fetched whole. An open delta walks back to a checkpoint and
 * applies patches. A sealed delta whose patch was deleted is readable only when
 * some checkpoint still has the same content fingerprint.
 */
export function reconstructPlan(versions: readonly FileVersionInfo[], targetId: string): ReconstructPlan {
  const byId = new Map(versions.map((version) => [version.versionId, version]));
  const target = byId.get(targetId);
  if (!target) return { mode: "missing" };
  if (versionKind(target) === "checkpoint") return { mode: "full", versionId: target.versionId };
  if (target.sealed) {
    const folded = target.foldedInto ? byId.get(target.foldedInto) : undefined;
    if (folded && versionKind(folded) === "checkpoint" && folded.contentMac === target.contentMac) {
      return { mode: "full", versionId: folded.versionId };
    }
    const same = versions.find((version) => versionKind(version) === "checkpoint" && version.contentMac === target.contentMac);
    if (same) return { mode: "full", versionId: same.versionId };
    return { mode: "sealed" };
  }
  const chain: FileVersionInfo[] = [];
  const seen = new Set<string>();
  let cursor: FileVersionInfo | undefined = target;
  while (cursor && versionKind(cursor) === "delta") {
    if (seen.has(cursor.versionId) || cursor.sealed) return { mode: "sealed" };
    seen.add(cursor.versionId);
    chain.push(cursor);
    cursor = cursor.baseVersionId ? byId.get(cursor.baseVersionId) : undefined;
  }
  if (!cursor || versionKind(cursor) !== "checkpoint") return { mode: "sealed" };
  chain.reverse();
  return { mode: "chain", checkpointId: cursor.versionId, deltaIds: chain.map((version) => version.versionId) };
}

export function retentionView(autoLimit: number, manualLimit: number | null): RetentionView {
  return {
    autoLimit: clampAutoVersionLimit(autoLimit),
    manualLimit,
    manualLimitEnforced: false,
  };
}

/**
 * Ids of auto versions past the newest `autoLimit`.
 * Manual and restore versions are never selected.
 */
export function autoVersionsToDrop<T extends { versionId: string; createdAt: number; syncTrigger: SyncTrigger }>(
  versions: readonly T[],
  autoLimit: number,
): string[] {
  const keep = clampAutoVersionLimit(autoLimit);
  const auto = versions.filter((version) => version.syncTrigger === "auto").sort(byNewest);
  return auto.slice(keep).map((version) => version.versionId);
}

/**
 * Group versions into calendar days that have at least one change.
 * `timeZoneOffsetMinutes` uses the same sign as `Date.getTimezoneOffset`
 * (UTC+8 is -480). Days are newest first. Versions inside a day are newest first.
 */
export function groupVersionsByDay(versions: readonly FileVersionInfo[], timeZoneOffsetMinutes = 0): VersionDayGroup[] {
  const grouped = new Map<string, FileVersionInfo[]>();
  for (const version of versions) {
    const day = dayKey(version.createdAt, timeZoneOffsetMinutes);
    const list = grouped.get(day);
    if (list) list.push(version);
    else grouped.set(day, [version]);
  }
  const days: VersionDayGroup[] = [];
  for (const [day, items] of grouped) {
    const sorted = [...items].sort(byNewest);
    let auto = 0;
    let manual = 0;
    let restore = 0;
    let bytes = 0;
    let earliest = sorted[0]?.createdAt ?? 0;
    let latest = sorted[0]?.createdAt ?? 0;
    for (const version of sorted) {
      if (version.syncTrigger === "auto") auto++;
      else if (version.syncTrigger === "manual") manual++;
      else restore++;
      bytes += version.size;
      if (version.createdAt < earliest) earliest = version.createdAt;
      if (version.createdAt > latest) latest = version.createdAt;
    }
    days.push({
      day,
      count: sorted.length,
      auto,
      manual,
      restore,
      bytes,
      earliest,
      latest,
      versions: sorted,
    });
  }
  days.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  return days;
}

/**
 * Last version of `day` and the last version of the previous day that has changes.
 * `groups` must be newest-day-first, as returned by `groupVersionsByDay`.
 */
export function previousChangedDayPair(
  groups: readonly VersionDayGroup[],
  day: string,
): { newer: FileVersionInfo; older: FileVersionInfo } | null {
  const index = groups.findIndex((group) => group.day === day);
  if (index < 0 || index + 1 >= groups.length) return null;
  const newer = groups[index]?.versions[0];
  const older = groups[index + 1]?.versions[0];
  if (!newer || !older) return null;
  return { newer, older };
}

export function diffVersionText(before: string, after: string): TextDiffLine[] | "too-large" {
  const left = before.split("\n");
  const right = after.split("\n");
  if (left.length > DIFF_LINE_CAP || right.length > DIFF_LINE_CAP) return "too-large";
  const rows = left.length + 1;
  const cols = right.length + 1;
  const scores: number[] = new Array(rows * cols).fill(0);
  const at = (i: number, j: number) => i * cols + j;
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      scores[at(i, j)] = left[i] === right[j]
        ? scores[at(i + 1, j + 1)] + 1
        : Math.max(scores[at(i + 1, j)], scores[at(i, j + 1)]);
    }
  }
  const out: TextDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      out.push({ op: "eq", text: left[i] ?? "" });
      i++;
      j++;
    } else if (scores[at(i + 1, j)] >= scores[at(i, j + 1)]) {
      out.push({ op: "del", text: left[i] ?? "" });
      i++;
    } else {
      out.push({ op: "add", text: right[j] ?? "" });
      j++;
    }
  }
  while (i < left.length) out.push({ op: "del", text: left[i++] ?? "" });
  while (j < right.length) out.push({ op: "add", text: right[j++] ?? "" });
  return out;
}

function byNewest<T extends { createdAt: number; versionId: string }>(a: T, b: T): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.versionId < b.versionId ? 1 : a.versionId > b.versionId ? -1 : 0;
}

function dayKey(ms: number, offsetMinutes: number): string {
  const local = new Date(ms - offsetMinutes * 60_000);
  const month = String(local.getUTCMonth() + 1).padStart(2, "0");
  const day = String(local.getUTCDate()).padStart(2, "0");
  return `${local.getUTCFullYear()}-${month}-${day}`;
}
