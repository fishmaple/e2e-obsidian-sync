/**
 * Client-only sync direction. The server protocol has no syncMode field.
 *
 * Stored on this vault's plugin data, next to autoSync and conflictPolicy.
 * Obsidian already keeps that data per vault. vaultBindings only remembers
 * which remote vault an account is tied to, so it is the wrong place for a
 * device policy.
 */
export type SyncMode = "push_only" | "bidirectional";

/** One pass over the existing rev / changes / deletions planner. */
export type SyncPass = "push" | "pull" | "both";

export type PlannedKind = "unchanged" | "upload" | "download" | "delete-local" | "delete-remote" | "conflict";

/** What this pass should do with one planned action. */
export type PlanDisposition = "run" | "skip" | "pending-pull";

export type ConflictPolicy = "ask" | "snapshot" | "overwrite";

export function normalizeSyncMode(value: unknown): SyncMode {
  return value === "push_only" ? "push_only" : "bidirectional";
}

/** Timer, dirty follow-up, and Sync now. */
export function passForSync(mode: SyncMode): SyncPass {
  return mode === "push_only" ? "push" : "both";
}

/**
 * Manual Pull. Bidirectional mode aliases Sync now so the command can stay hidden.
 */
export function passForPull(mode: SyncMode): SyncPass {
  return mode === "push_only" ? "pull" : "both";
}

export function showsPullCommand(mode: SyncMode): boolean {
  return mode === "push_only";
}

/**
 * Push uploads and still propagates deletions, but does not apply remote
 * content. Pull applies remote content and deletions, and leaves clean local
 * edits for the next push. Conflicts are resolved only on pull or both.
 */
export function planDisposition(pass: SyncPass, kind: PlannedKind): PlanDisposition {
  if (kind === "unchanged" || kind === "delete-local" || kind === "delete-remote") return "run";
  if (pass === "both") return "run";
  if (pass === "push") {
    if (kind === "upload") return "run";
    return "pending-pull";
  }
  if (kind === "download" || kind === "conflict") return "run";
  return "skip";
}

/**
 * Mode A pull must open the conflict dialog. Overwrite and snapshot must not
 * replace a local edit without asking. Mode B keeps the stored policy.
 */
export function conflictPolicyForPass(mode: SyncMode, pass: SyncPass, policy: ConflictPolicy): ConflictPolicy {
  if (mode === "push_only" && pass === "pull") return "ask";
  return policy;
}
