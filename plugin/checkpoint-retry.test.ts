import assert from "node:assert/strict";
import test from "node:test";
import {
  checkpointCountsMatter,
  checkpointFailureKind,
  emptyCheckpointCounts,
  forgetCheckpointRetry,
  normalizeCheckpointRetries,
  rememberCheckpointRetry,
  type CheckpointRetry,
} from "./src/checkpoint-retry";

const FILE = "ab".repeat(32);
const MAC = "cd".repeat(32);

function retry(partial: Partial<CheckpointRetry> = {}): CheckpointRetry {
  return {
    fileId: FILE,
    tipRev: 2,
    contentMac: MAC,
    size: 4,
    mtime: 10,
    encoding: "plain",
    syncTrigger: "auto",
    ...partial,
  };
}

test("a failed checkpoint keeps only the latest tip for that file", () => {
  const first = rememberCheckpointRetry({}, retry());
  const second = rememberCheckpointRetry(first, retry({ tipRev: 5, contentMac: "ee".repeat(32), syncTrigger: "manual" }));
  assert.equal(Object.keys(second).length, 1);
  assert.equal(second[FILE]?.tipRev, 5);
  assert.equal(second[FILE]?.contentMac, "ee".repeat(32));
  assert.equal(second[FILE]?.syncTrigger, "manual");
  const cleared = forgetCheckpointRetry(second, FILE);
  assert.deepEqual(cleared, {});
  assert.equal(forgetCheckpointRetry(cleared, FILE), cleared);
});

test("tip moved is quiet and other checkpoint errors are failures", () => {
  assert.equal(checkpointFailureKind({ name: "SyncConflictError", status: 409, reason: "parent_rev" }), "skippedTipMoved");
  assert.equal(checkpointFailureKind({ name: "SyncConflictError", status: 409, reason: "deleted" }), "failed");
  assert.equal(checkpointFailureKind(new Error("network")), "failed");
  assert.equal(checkpointFailureKind("nope"), "failed");
  const counts = emptyCheckpointCounts();
  counts.failed = 1;
  assert.equal(checkpointCountsMatter(counts), true);
  assert.equal(checkpointCountsMatter(emptyCheckpointCounts()), false);
});

test("stored checkpoint retries drop malformed rows", () => {
  const kept = normalizeCheckpointRetries({
    [FILE]: retry(),
    ["nope"]: retry({ fileId: "nope" }),
    [MAC]: { ...retry({ fileId: MAC }), tipRev: 0 },
  });
  assert.deepEqual(Object.keys(kept), [FILE]);
  assert.equal(kept[FILE]?.tipRev, 2);
  assert.deepEqual(normalizeCheckpointRetries(null), {});
});
