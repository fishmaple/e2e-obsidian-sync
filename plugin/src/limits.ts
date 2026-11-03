import { MAX_FILE_BYTES } from "../../shared/src/protocol";

export const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_TRASH_DAYS = 30;
export const DEFAULT_TRASH_FILES = 200;

export function clampMaxFileBytes(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_FILE_BYTES;
  return Math.min(MAX_FILE_BYTES, Math.max(1024 * 1024, Math.floor(parsed)));
}

export function clampNonNegative(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export function clampTrashDays(value: unknown): number {
  const parsed = clampNonNegative(value, DEFAULT_TRASH_DAYS, 3650);
  return parsed === 0 ? DEFAULT_TRASH_DAYS : parsed;
}
