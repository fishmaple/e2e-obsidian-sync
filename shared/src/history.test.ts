import assert from "node:assert/strict";
import test from "node:test";
import {
  autoVersionsToDrop,
  evaluateFlush,
  flushReasonForSync,
  FLUSH_DELTA_AGE_MS,
  FLUSH_DELTA_BYTES,
  FLUSH_DELTA_COUNT,
  historyVersionsToDrop,
  MAX_DELTA_PATCH_BYTES,
  planHistoryKind,
  reconstructPlan,
  diffVersionText,
  groupVersionsByDay,
  previousChangedDayPair,
  type FileVersionInfo,
} from "./history";

function version(partial: Partial<FileVersionInfo> & Pick<FileVersionInfo, "versionId" | "createdAt" | "syncTrigger">): FileVersionInfo {
  return {
    fileId: "ab".repeat(32),
    size: 10,
    mtime: partial.createdAt,
    encoding: "e2ee",
    tipRev: 1,
    contentMac: "cd".repeat(32),
    ...partial,
  };
}

test("day grouping skips empty days and summarizes each day that changed", () => {
  const nov1Early = Date.UTC(2026, 10, 1, 2, 0);
  const nov1Late = Date.UTC(2026, 10, 1, 18, 30);
  const nov3 = Date.UTC(2026, 10, 3, 9, 15);
  const versions = [
    version({ versionId: "a".repeat(64), createdAt: nov1Early, syncTrigger: "auto", size: 4 }),
    version({ versionId: "b".repeat(64), createdAt: nov3, syncTrigger: "manual", size: 8 }),
    version({ versionId: "c".repeat(64), createdAt: nov1Late, syncTrigger: "auto", size: 6, encoding: "plain" }),
    version({ versionId: "d".repeat(64), createdAt: nov1Late + 5, syncTrigger: "restore", size: 1 }),
  ];
  const days = groupVersionsByDay(versions, 0);
  assert.deepEqual(days.map((day) => day.day), ["2026-11-03", "2026-11-01"]);
  assert.equal(days[0]?.count, 1);
  assert.equal(days[0]?.manual, 1);
  assert.equal(days[0]?.auto, 0);
  assert.equal(days[1]?.count, 3);
  assert.equal(days[1]?.auto, 2);
  assert.equal(days[1]?.restore, 1);
  assert.equal(days[1]?.manual, 0);
  assert.equal(days[1]?.bytes, 11);
  assert.equal(days[1]?.earliest, nov1Early);
  assert.equal(days[1]?.latest, nov1Late + 5);
  assert.deepEqual(days[1]?.versions.map((item) => item.versionId), ["d".repeat(64), "c".repeat(64), "a".repeat(64)]);

  const pair = previousChangedDayPair(days, "2026-11-03");
  assert.equal(pair?.newer.versionId, "b".repeat(64));
  assert.equal(pair?.older.versionId, "d".repeat(64));
  assert.equal(previousChangedDayPair(days, "2026-11-01"), null);
  assert.equal(previousChangedDayPair(days, "2026-11-02"), null);
});

test("day keys follow the client timezone offset", () => {
  const lateUtc = Date.UTC(2026, 10, 1, 23, 30);
  const days = groupVersionsByDay([
    version({ versionId: "e".repeat(64), createdAt: lateUtc, syncTrigger: "auto" }),
  ], -480);
  assert.equal(days[0]?.day, "2026-11-02");
});

test("auto retention drops only auto versions past the newest limit", () => {
  const rows = [
    { versionId: "m1", createdAt: 4, syncTrigger: "manual" as const },
    { versionId: "a1", createdAt: 1, syncTrigger: "auto" as const },
    { versionId: "r1", createdAt: 5, syncTrigger: "restore" as const },
    { versionId: "a2", createdAt: 2, syncTrigger: "auto" as const },
    { versionId: "a3", createdAt: 3, syncTrigger: "auto" as const },
  ];
  assert.deepEqual(autoVersionsToDrop(rows, 2), ["a1"]);
  assert.deepEqual(autoVersionsToDrop(rows, 100).length, 0);
  assert.deepEqual(autoVersionsToDrop(rows, 1), ["a2", "a1"]);
});

test("flush fires on count, bytes, or one day, and manual forces it", () => {
  const now = 1_700_000_000_000;
  const small = { size: 100, patchBytes: 40, createdAt: now - 1000 };
  assert.equal(evaluateFlush([small], now).due, false);
  assert.equal(evaluateFlush(Array.from({ length: FLUSH_DELTA_COUNT - 1 }, () => small), now).due, false);
  const counted = evaluateFlush(Array.from({ length: FLUSH_DELTA_COUNT }, () => small), now);
  assert.equal(counted.due, true);
  assert.equal(counted.reason, "count");
  assert.equal(counted.pendingBytes, FLUSH_DELTA_COUNT * 100);

  const bulky = evaluateFlush([{ size: FLUSH_DELTA_BYTES, patchBytes: 10, createdAt: now }], now);
  assert.equal(bulky.reason, "bytes");
  const patchBulky = evaluateFlush([{ size: 10, patchBytes: FLUSH_DELTA_BYTES, createdAt: now }], now);
  assert.equal(patchBulky.reason, "bytes");

  const fresh = evaluateFlush([{ size: 10, patchBytes: 10, createdAt: now - FLUSH_DELTA_AGE_MS + 1 }], now);
  assert.equal(fresh.due, false);
  const aged = evaluateFlush([{ size: 10, patchBytes: 10, createdAt: now - FLUSH_DELTA_AGE_MS }], now);
  assert.equal(aged.due, true);
  assert.equal(aged.reason, "age");
  assert.equal(aged.earliest, now - FLUSH_DELTA_AGE_MS);

  assert.equal(evaluateFlush([], now, "manual").reason, "manual");
  assert.equal(evaluateFlush([], now, "restore").due, true);
});

test("manual sync flushes every open delta and auto sync keeps the thresholds", () => {
  const now = 1_700_000_000_000;
  const small = { size: 20, patchBytes: 8, createdAt: now - 1000 };
  assert.equal(flushReasonForSync([small], now, "auto").due, false);
  const manual = flushReasonForSync([small], now, "manual");
  assert.equal(manual.due, true);
  assert.equal(manual.reason, "manual");
  assert.equal(flushReasonForSync([], now, "manual").due, false);
  assert.equal(flushReasonForSync([{ size: 10, patchBytes: 4, createdAt: now - FLUSH_DELTA_AGE_MS }], now, "auto").reason, "age");
  assert.equal(flushReasonForSync(Array.from({ length: FLUSH_DELTA_COUNT }, () => small), now, "auto").reason, "count");
});

test("history writes are deltas only for an auto edit with a usable patch", () => {
  assert.equal(planHistoryKind({ syncTrigger: "auto", hasParent: true, patchBytes: 20 }), "delta");
  assert.equal(planHistoryKind({ syncTrigger: "manual", hasParent: true, patchBytes: 20 }), "checkpoint");
  assert.equal(planHistoryKind({ syncTrigger: "restore", hasParent: true, patchBytes: 20 }), "checkpoint");
  assert.equal(planHistoryKind({ syncTrigger: "auto", hasParent: false, patchBytes: 20 }), "checkpoint");
  assert.equal(planHistoryKind({ syncTrigger: "auto", hasParent: true, patchBytes: null }), "checkpoint");
  assert.equal(planHistoryKind({ syncTrigger: "auto", hasParent: true, patchBytes: MAX_DELTA_PATCH_BYTES + 1 }), "checkpoint");
});

test("retention drops old auto checkpoints and the sealed deltas folded into them", () => {
  const rows = [
    { versionId: "c1", createdAt: 1, syncTrigger: "auto" as const, kind: "checkpoint" as const },
    { versionId: "d1", createdAt: 2, syncTrigger: "auto" as const, kind: "delta" as const, sealed: true, foldedInto: "c1" },
    { versionId: "d2", createdAt: 3, syncTrigger: "auto" as const, kind: "delta" as const, sealed: false, foldedInto: "" },
    { versionId: "c2", createdAt: 4, syncTrigger: "auto" as const, kind: "checkpoint" as const },
    { versionId: "m1", createdAt: 5, syncTrigger: "manual" as const, kind: "checkpoint" as const },
    { versionId: "r1", createdAt: 6, syncTrigger: "restore" as const, kind: "checkpoint" as const },
  ];
  assert.deepEqual(historyVersionsToDrop(rows, 1).sort(), ["c1", "d1"]);
  assert.deepEqual(historyVersionsToDrop(rows, 2), []);
});

test("reconstruction walks a checkpoint plus open deltas and refuses a sealed gap", () => {
  const fileId = "ab".repeat(32);
  const mac = "cd".repeat(32);
  const checkpoint = version({
    versionId: "1".repeat(64),
    createdAt: 1,
    syncTrigger: "auto",
    kind: "checkpoint",
    contentMac: mac,
    fileId,
  });
  const open = version({
    versionId: "2".repeat(64),
    createdAt: 2,
    syncTrigger: "auto",
    kind: "delta",
    baseVersionId: checkpoint.versionId,
    sealed: false,
    contentMac: "ee".repeat(32),
    fileId,
  });
  const sealed = version({
    versionId: "3".repeat(64),
    createdAt: 3,
    syncTrigger: "auto",
    kind: "delta",
    baseVersionId: open.versionId,
    sealed: true,
    foldedInto: "4".repeat(64),
    contentMac: "ff".repeat(32),
    fileId,
  });
  const folded = version({
    versionId: "4".repeat(64),
    createdAt: 4,
    syncTrigger: "auto",
    kind: "checkpoint",
    contentMac: mac,
    fileId,
  });
  const sameMac = version({
    ...sealed,
    versionId: "5".repeat(64),
    contentMac: mac,
    foldedInto: folded.versionId,
  });
  const versions = [checkpoint, open, sealed, folded, sameMac];
  assert.deepEqual(reconstructPlan(versions, checkpoint.versionId), { mode: "full", versionId: checkpoint.versionId });
  assert.deepEqual(reconstructPlan(versions, open.versionId), {
    mode: "chain",
    checkpointId: checkpoint.versionId,
    deltaIds: [open.versionId],
  });
  assert.deepEqual(reconstructPlan(versions, sealed.versionId), { mode: "sealed" });
  assert.deepEqual(reconstructPlan(versions, sameMac.versionId), { mode: "full", versionId: folded.versionId });
  assert.equal(reconstructPlan(versions, "0".repeat(64)).mode, "missing");
});

test("version text diff marks inserted and removed lines", () => {
  const diff = diffVersionText("one\ntwo\nthree", "one\nTWO\nthree\nfour");
  assert.notEqual(diff, "too-large");
  if (diff === "too-large") return;
  assert.deepEqual(diff.map((line) => `${line.op}:${line.text}`), [
    "eq:one",
    "del:two",
    "add:TWO",
    "eq:three",
    "add:four",
  ]);
});
