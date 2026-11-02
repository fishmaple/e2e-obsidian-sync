import type { Encoding, PayloadCipher } from "./protocol";

/** Auto versions kept per file when a file has no saved limit. */
export const AUTO_VERSION_LIMIT_DEFAULT = 100;
export const AUTO_VERSION_LIMIT_MIN = 1;
export const AUTO_VERSION_LIMIT_MAX = 256;

export type SyncTrigger = "auto" | "manual" | "restore";

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

export function clampAutoVersionLimit(value: number): number {
  if (!Number.isFinite(value)) return AUTO_VERSION_LIMIT_DEFAULT;
  return Math.min(AUTO_VERSION_LIMIT_MAX, Math.max(AUTO_VERSION_LIMIT_MIN, Math.floor(value)));
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
