import assert from "node:assert/strict";
import test from "node:test";
import {
  autoVersionsToDrop,
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
