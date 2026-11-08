import assert from "node:assert/strict";
import test from "node:test";
import { decideSyncAction } from "../shared/src/reconcile";
import {
  conflictPolicyForPass,
  formatLiveStatus,
  normalizeSyncMode,
  passForPull,
  passForSync,
  planDisposition,
  shouldNoticePendingPull,
  showsPullCommand,
  statusBarActivatesPull,
  type PlannedKind,
} from "./src/sync-mode";

const local = (contentMac: string) => ({ contentMac, encoding: "e2ee" as const });
const remote = (contentMac: string, rev: number) => ({ contentMac, rev, encoding: "e2ee" as const });

test("missing or unknown sync mode stays bidirectional", () => {
  assert.equal(normalizeSyncMode(undefined), "bidirectional");
  assert.equal(normalizeSyncMode("pull_only"), "bidirectional");
  assert.equal(normalizeSyncMode("bidirectional"), "bidirectional");
  assert.equal(normalizeSyncMode("push_only"), "push_only");
});

test("sync now is push-only in mode A and both directions in mode B", () => {
  assert.equal(passForSync("push_only"), "push");
  assert.equal(passForSync("bidirectional"), "both");
  assert.equal(passForPull("push_only"), "pull");
  assert.equal(passForPull("bidirectional"), "both");
  assert.equal(showsPullCommand("push_only"), true);
  assert.equal(showsPullCommand("bidirectional"), false);
});

test("push pass uploads and propagates deletions, and holds remote content", () => {
  assert.equal(planDisposition("push", "upload"), "run");
  assert.equal(planDisposition("push", "delete-local"), "run");
  assert.equal(planDisposition("push", "delete-remote"), "run");
  assert.equal(planDisposition("push", "unchanged"), "run");
  assert.equal(planDisposition("push", "download"), "pending-pull");
  assert.equal(planDisposition("push", "conflict"), "pending-pull");
});

test("pull pass downloads and opens conflicts without uploading clean local edits", () => {
  assert.equal(planDisposition("pull", "download"), "run");
  assert.equal(planDisposition("pull", "conflict"), "run");
  assert.equal(planDisposition("pull", "delete-local"), "run");
  assert.equal(planDisposition("pull", "delete-remote"), "run");
  assert.equal(planDisposition("pull", "upload"), "skip");
  assert.equal(planDisposition("pull", "unchanged"), "run");
});

test("bidirectional pass runs every planned action", () => {
  const kinds: PlannedKind[] = ["unchanged", "upload", "download", "delete-local", "delete-remote", "conflict"];
  for (const kind of kinds) assert.equal(planDisposition("both", kind), "run");
});

test("a clean remote edit is counted on push and applied on pull or both", () => {
  const action = decideSyncAction({
    local: local("aa"),
    remote: remote("bb", 4),
    base: { rev: 3, contentMac: "aa" },
  });
  assert.equal(action.type, "download");
  assert.equal(planDisposition("push", action.type), "pending-pull");
  assert.equal(planDisposition("pull", action.type), "run");
  assert.equal(planDisposition("both", action.type), "run");
});

test("a local edit against an unchanged remote stays an upload, skipped by pull", () => {
  const action = decideSyncAction({
    local: local("bb"),
    remote: remote("aa", 3),
    base: { rev: 3, contentMac: "aa" },
  });
  assert.equal(action.type, "upload");
  assert.equal(planDisposition("push", action.type), "run");
  assert.equal(planDisposition("pull", action.type), "skip");
  assert.equal(planDisposition("both", action.type), "run");
});

test("deletion of an unchanged file still propagates in push mode", () => {
  const remoteGone = decideSyncAction({
    local: local("aa"),
    remote: null,
    base: { rev: 2, contentMac: "aa" },
  });
  const localGone = decideSyncAction({
    local: null,
    remote: remote("aa", 2),
    base: { rev: 2, contentMac: "aa" },
  });
  assert.equal(remoteGone.type, "delete-local");
  assert.equal(localGone.type, "delete-remote");
  assert.equal(planDisposition("push", remoteGone.type), "run");
  assert.equal(planDisposition("push", localGone.type), "run");
  assert.equal(planDisposition("pull", remoteGone.type), "run");
  assert.equal(planDisposition("pull", localGone.type), "run");
});

test("push-only status leads with the pending pull and the click pulls", () => {
  assert.equal(statusBarActivatesPull("push_only", 2), true);
  assert.equal(statusBarActivatesPull("push_only", 0), false);
  assert.equal(statusBarActivatesPull("bidirectional", 4), false);
  const crowded = formatLiveStatus({
    pendingPull: "[Pull 2]",
    pending: "Unsynced 1",
    synced: "Synced 9",
    current: " · This note is pending",
    pullFirst: true,
  });
  assert.equal(crowded, "[Pull 2] · Unsynced 1 · Synced 9 · This note is pending");
  assert.equal(crowded.startsWith("[Pull 2]"), true);
  assert.equal(formatLiveStatus({
    pendingPull: "[Pull 2]",
    pending: "Unsynced 1",
    synced: "Synced 9",
    current: "",
    pullFirst: false,
  }), "Unsynced 1 · Synced 9");
});

test("pending-pull notice follows a push that still has remote changes", () => {
  assert.equal(shouldNoticePendingPull({ pass: "push", before: 0, after: 3, manual: false }), true);
  assert.equal(shouldNoticePendingPull({ pass: "push", before: 3, after: 5, manual: false }), true);
  assert.equal(shouldNoticePendingPull({ pass: "push", before: 3, after: 3, manual: false }), false);
  assert.equal(shouldNoticePendingPull({ pass: "push", before: 3, after: 3, manual: true }), true);
  assert.equal(shouldNoticePendingPull({ pass: "push", before: 3, after: 0, manual: true }), false);
  assert.equal(shouldNoticePendingPull({ pass: "both", before: 0, after: 3, manual: true }), false);
  assert.equal(shouldNoticePendingPull({ pass: "pull", before: 0, after: 2, manual: true }), false);
});

test("a diverged file is a conflict held on push and asked on mode A pull", () => {
  const action = decideSyncAction({
    local: local("bb"),
    remote: remote("cc", 5),
    base: { rev: 3, contentMac: "aa" },
  });
  assert.equal(action.type, "conflict");
  assert.equal(planDisposition("push", action.type), "pending-pull");
  assert.equal(planDisposition("pull", action.type), "run");
  assert.equal(conflictPolicyForPass("push_only", "pull", "overwrite"), "ask");
  assert.equal(conflictPolicyForPass("push_only", "pull", "snapshot"), "ask");
  assert.equal(conflictPolicyForPass("push_only", "pull", "ask"), "ask");
  assert.equal(conflictPolicyForPass("bidirectional", "both", "overwrite"), "overwrite");
  assert.equal(conflictPolicyForPass("bidirectional", "both", "snapshot"), "snapshot");
  assert.equal(conflictPolicyForPass("bidirectional", "both", "ask"), "ask");
  assert.equal(conflictPolicyForPass("push_only", "both", "overwrite"), "overwrite");
});
