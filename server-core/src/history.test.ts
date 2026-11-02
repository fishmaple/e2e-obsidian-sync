import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bytesToBase64 } from "../../shared/src/codec";
import { FLUSH_DELTA_BYTES, groupVersionsByDay, type RetentionView, type VersionListResponse } from "../../shared/src/history";
import type { ConflictBody, PutResult } from "../../shared/src/protocol";
import { createApp } from "./app";
import type { AppConfig } from "./config";
import { openDatabase } from "./db";

const FILE = "ab".repeat(32);
const OTHER = "cd".repeat(32);

test("auto retention trims only auto versions and keeps a manual cap unset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-history-keep-"));
  const db = await openDatabase(testConfig(dir));
  const app = createApp({ config: testConfig(dir), db });
  try {
    const token = await devToken(app);
    const macs = ["11", "22", "33", "44", "55", "66", "77"].map((byte) => byte.repeat(32));
    let parent: number | null = null;
    const triggers = ["auto", "auto", "auto", "auto", "manual", "manual", "auto"] as const;
    for (let index = 0; index < macs.length; index++) {
      const put = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("笔记", macs[index] ?? "", `v${index}`, parent, {
        syncTrigger: triggers[index],
        autoLimit: 2,
      }));
      assert.equal(put.status, 200, await put.clone().text());
      parent = (await put.json() as PutResult).rev;
    }
    const capped = await authed(app, token, "PUT", `/api/v1/files/${FILE}/retention`, { manualLimit: 1 });
    assert.equal(capped.status, 200, await capped.clone().text());
    const retention = await capped.json() as RetentionView;
    assert.equal(retention.autoLimit, 2);
    assert.equal(retention.manualLimit, 1);
    assert.equal(retention.manualLimitEnforced, false);

    const extraManual = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("笔记", "88".repeat(32), "extra", parent, {
      syncTrigger: "manual",
    }));
    assert.equal(extraManual.status, 200, await extraManual.clone().text());

    const listed = await authed(app, token, "GET", `/api/v1/files/${FILE}/versions?vault=${encodeURIComponent("笔记")}`);
    assert.equal(listed.status, 200, await listed.clone().text());
    const body = await listed.json() as VersionListResponse;
    const kept = new Set(body.versions.map((version) => version.contentMac));
    assert.equal(kept.has(macs[0] ?? ""), false);
    assert.equal(kept.has(macs[1] ?? ""), false);
    assert.equal(kept.has(macs[2] ?? ""), false);
    assert.equal(kept.has(macs[3] ?? ""), true);
    assert.equal(kept.has(macs[4] ?? ""), true);
    assert.equal(kept.has(macs[5] ?? ""), true);
    assert.equal(kept.has("88".repeat(32)), true);
    assert.equal(kept.has(macs[6] ?? ""), true);
    assert.equal(body.versions.filter((version) => version.syncTrigger === "auto").length, 2);
    assert.equal(body.versions.filter((version) => version.syncTrigger === "manual").length, 3);
    assert.equal(body.retention.manualLimitEnforced, false);
    const days = groupVersionsByDay(body.versions, 0);
    assert.ok(days.length >= 1);
    assert.equal(days.reduce((sum, day) => sum + day.count, 0), body.versions.length);
    assert.ok(days.every((day) => day.count > 0));

    const same = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("笔记", "88".repeat(32), "extra", 1, {
      syncTrigger: "auto",
      autoLimit: 2,
    }));
    assert.equal(same.status, 200, await same.clone().text());
    const afterSame = await authed(app, token, "GET", `/api/v1/files/${FILE}/versions?vault=${encodeURIComponent("笔记")}`);
    const afterBody = await afterSame.json() as VersionListResponse;
    assert.equal(afterBody.versions.length, body.versions.length);

    const stale = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("笔记", "99".repeat(32), "stale", 1, {
      syncTrigger: "auto",
    }));
    assert.equal(stale.status, 409);
    const afterStale = await authed(app, token, "GET", `/api/v1/files/${FILE}/versions?vault=${encodeURIComponent("笔记")}`);
    assert.equal((await afterStale.json() as VersionListResponse).versions.length, body.versions.length);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore writes a new tip revision and plaintext wipe leaves ciphertext versions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-history-restore-"));
  const db = await openDatabase(testConfig(dir));
  const app = createApp({ config: testConfig(dir), db });
  try {
    const token = await devToken(app);
    const created = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("库", "aa".repeat(32), "one", null, {
      syncTrigger: "manual",
    }));
    assert.equal(created.status, 200, await created.clone().text());
    assert.equal((await created.json() as PutResult).rev, 1);

    const updated = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("库", "bb".repeat(32), "two", 1, {
      syncTrigger: "auto",
    }));
    assert.equal(updated.status, 200, await updated.clone().text());
    assert.equal((await updated.json() as PutResult).rev, 2);

    const earlyVaults = await authed(app, token, "GET", "/api/v1/vaults");
    const earlyId = (await earlyVaults.json() as { vaults: { id: string; name: string }[] }).vaults.find((vault) => vault.name === "库")?.id ?? "";
    assert.ok(earlyId);
    const blocked = await authed(app, token, "POST", `/api/v1/vaults/${earlyId}/plaintext-history`);
    assert.equal(blocked.status, 409);

    const encrypted = await authed(app, token, "PUT", `/api/v1/objects/${OTHER}`, cipherObject("库", "cc".repeat(32), null));
    assert.equal(encrypted.status, 200, await encrypted.clone().text());

    const listed = await authed(app, token, "GET", `/api/v1/files/${FILE}/versions?vault=${encodeURIComponent("库")}`);
    const versions = (await listed.json() as VersionListResponse).versions;
    const plainFirst = versions.find((version) => version.contentMac === "aa".repeat(32));
    assert.ok(plainFirst);
    assert.equal(plainFirst.encoding, "plain");
    assert.equal(versions.some((version) => version.syncTrigger === "auto"), true);
    assert.equal(versions.some((version) => version.syncTrigger === "manual"), true);

    const vaultId = earlyId;
    const beforeWipe = await authed(app, token, "GET", `/api/v1/files/${FILE}/versions?vault=${encodeURIComponent("库")}`);
    assert.equal((await beforeWipe.json() as VersionListResponse).versions.some((version) => version.encoding === "plain"), true);

    const restored = await authed(app, token, "POST", `/api/v1/files/${FILE}/versions/${plainFirst.versionId}/restore`, {
      vaultId,
      parentRev: 2,
    });
    assert.equal(restored.status, 200, await restored.clone().text());
    const restoredBody = await restored.json() as PutResult;
    assert.equal(restoredBody.rev, 3);
    assert.equal(restoredBody.contentMac, "aa".repeat(32));

    const tip = await authed(app, token, "GET", `/api/v1/objects/${FILE}`);
    const tipBody = await tip.json() as { contentCipher: { raw: string }; rev: number; encoding: string };
    assert.equal(tipBody.rev, 3);
    assert.equal(tipBody.encoding, "plain");
    assert.equal(new TextDecoder().decode(bytesFromBase64(tipBody.contentCipher.raw)), "one");

    const moved = versions.find((version) => version.contentMac === "bb".repeat(32));
    assert.ok(moved);
    const conflict = await authed(app, token, "POST", `/api/v1/files/${FILE}/versions/${moved.versionId}/restore`, {
      vaultId,
      parentRev: 2,
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as ConflictBody).reason, "parent_rev");
    const still = await authed(app, token, "GET", `/api/v1/objects/${FILE}`);
    assert.equal((await still.json() as { rev: number }).rev, 3);

    const afterRestore = await authed(app, token, "GET", `/api/v1/files/${FILE}/versions?vault=${encodeURIComponent("库")}`);
    const restoredVersions = (await afterRestore.json() as VersionListResponse).versions;
    assert.equal(restoredVersions.some((version) => version.syncTrigger === "restore" && version.tipRev === 3), true);

    const downloads = await authed(app, token, "POST", `/api/v1/files/${FILE}/version-urls`, {
      vault: vaultId,
      versionIds: [plainFirst.versionId, restoredVersions[0]?.versionId],
    });
    assert.equal(downloads.status, 200, await downloads.clone().text());
    const urls = (await downloads.json() as { downloads: { url: string; versionId: string }[] }).downloads;
    assert.equal(urls.length, 2);
    const fetched = await app.request(urls[0]?.url ?? "");
    assert.equal(fetched.status, 200);
    assert.match(await fetched.text(), /"v":0/);

    const wiped = await authed(app, token, "POST", `/api/v1/vaults/${vaultId}/plaintext-history`);
    assert.equal(wiped.status, 200, await wiped.clone().text());
    assert.ok((await wiped.json() as { deleted: number }).deleted >= 1);

    const plainLeft = await authed(app, token, "GET", `/api/v1/files/${FILE}/versions?vault=${encodeURIComponent("库")}`);
    const plainVersions = (await plainLeft.json() as VersionListResponse).versions;
    assert.equal(plainVersions.some((version) => version.encoding === "plain"), false);

    const cipherLeft = await authed(app, token, "GET", `/api/v1/files/${OTHER}/versions?vault=${encodeURIComponent("库")}`);
    const cipherVersions = (await cipherLeft.json() as VersionListResponse).versions;
    assert.equal(cipherVersions.length, 1);
    assert.equal(cipherVersions[0]?.encoding, "e2ee");
    assert.equal(cipherVersions[0]?.syncTrigger, "auto");

    const plainTip = await authed(app, token, "GET", `/api/v1/objects/${FILE}`);
    assert.equal(plainTip.status, 200);
    assert.equal((await plainTip.json() as { encoding: string; rev: number }).encoding, "plain");
    const cipherTip = await authed(app, token, "GET", `/api/v1/objects/${OTHER}`);
    assert.equal(cipherTip.status, 200);
    assert.equal((await cipherTip.json() as { encoding: string }).encoding, "e2ee");

    const gone = await authed(app, token, "POST", `/api/v1/files/${FILE}/version-urls`, {
      vault: vaultId,
      versionIds: [plainFirst.versionId],
    });
    assert.equal(gone.status, 404);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto deltas stay in the database until a checkpoint seals them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-history-delta-"));
  const db = await openDatabase(testConfig(dir));
  const app = createApp({ config: testConfig(dir), db });
  try {
    const token = await devToken(app);
    const firstMac = "a1".repeat(32);
    const secondMac = "a2".repeat(32);
    const thirdMac = "a3".repeat(32);
    const created = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("增量", firstMac, "one", null, {
      syncTrigger: "auto",
      historyKind: "delta",
      patchCipher: plainPatch("ignored"),
    }));
    assert.equal(created.status, 200, await created.clone().text());
    const createdBody = await created.json() as { rev: number; historyKind: string; versionId: string; flush: { due: boolean } };
    assert.equal(createdBody.rev, 1);
    assert.equal(createdBody.historyKind, "checkpoint");
    assert.equal(createdBody.flush.due, false);
    assert.deepEqual(listHistoryFiles(dir), [createdBody.versionId]);

    const delta = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("增量", secondMac, "two", 1, {
      syncTrigger: "auto",
      historyKind: "delta",
      patchCipher: plainPatch("two-patch"),
    }));
    assert.equal(delta.status, 200, await delta.clone().text());
    const deltaBody = await delta.json() as { rev: number; historyKind: string; versionId: string; flush: { due: boolean; pendingCount: number } };
    assert.equal(deltaBody.rev, 2);
    assert.equal(deltaBody.historyKind, "delta");
    assert.equal(deltaBody.flush.due, false);
    assert.equal(deltaBody.flush.pendingCount, 1);
    assert.deepEqual(listHistoryFiles(dir), [createdBody.versionId]);

    const vaults = await authed(app, token, "GET", "/api/v1/vaults");
    const vaultId = (await vaults.json() as { vaults: { id: string; name: string }[] }).vaults.find((vault) => vault.name === "增量")?.id ?? "";
    assert.ok(vaultId);
    const patchUrl = await authed(app, token, "POST", `/api/v1/files/${FILE}/version-urls`, {
      vault: vaultId,
      versionIds: [deltaBody.versionId],
    });
    assert.equal(patchUrl.status, 200, await patchUrl.clone().text());
    const patchLink = (await patchUrl.json() as { downloads: { url: string; kind: string }[] }).downloads[0];
    assert.equal(patchLink?.kind, "delta");
    const patchBody = await (await app.request(patchLink?.url ?? "")).text();
    const patchJson = JSON.parse(patchBody) as { raw: string };
    assert.equal(new TextDecoder().decode(Buffer.from(patchJson.raw, "base64")), "two-patch");

    const bulky = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("增量", thirdMac, "three", 2, {
      syncTrigger: "auto",
      historyKind: "delta",
      patchCipher: plainPatch("three-patch"),
      size: FLUSH_DELTA_BYTES,
    }));
    assert.equal(bulky.status, 200, await bulky.clone().text());
    const bulkyBody = await bulky.json() as { rev: number; historyKind: string; flush: { due: boolean; reason: string; pendingBytes: number } };
    assert.equal(bulkyBody.historyKind, "delta");
    assert.equal(bulkyBody.flush.due, true);
    assert.equal(bulkyBody.flush.reason, "bytes");
    assert.ok(bulkyBody.flush.pendingBytes >= FLUSH_DELTA_BYTES);

    const unchanged = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("增量", thirdMac, "three", 1, {
      syncTrigger: "auto",
      historyKind: "delta",
      patchCipher: plainPatch("again"),
      size: FLUSH_DELTA_BYTES,
    }));
    assert.equal(unchanged.status, 200, await unchanged.clone().text());
    const beforeSeal = await authed(app, token, "GET", `/api/v1/files/${FILE}/versions?vault=${encodeURIComponent("增量")}`);
    const beforeCount = (await beforeSeal.json() as VersionListResponse).versions.length;

    const stale = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("增量", "b4".repeat(32), "nope", 1, {
      syncTrigger: "auto",
      historyKind: "delta",
      patchCipher: plainPatch("nope"),
    }));
    assert.equal(stale.status, 409);
    const afterStale = await authed(app, token, "GET", `/api/v1/files/${FILE}/versions?vault=${encodeURIComponent("增量")}`);
    assert.equal((await afterStale.json() as VersionListResponse).versions.length, beforeCount);

    const tip = await authed(app, token, "GET", `/api/v1/objects/${FILE}`);
    const tipBody = await tip.json() as { contentCipher: { v: number; raw: string }; rev: number; contentMac: string; size: number; mtime: number; encoding: string };
    const sealed = await authed(app, token, "POST", `/api/v1/files/${FILE}/checkpoints`, {
      vault: vaultId,
      contentCipher: tipBody.contentCipher,
      contentMac: tipBody.contentMac,
      size: tipBody.size,
      mtime: tipBody.mtime,
      encoding: tipBody.encoding,
      tipRev: tipBody.rev,
      syncTrigger: "auto",
    });
    assert.equal(sealed.status, 200, await sealed.clone().text());
    const sealedBody = await sealed.json() as { versionId: string; historyKind: string; flush: { due: boolean; pendingCount: number } };
    assert.equal(sealedBody.historyKind, "checkpoint");
    assert.equal(sealedBody.flush.due, false);
    assert.equal(sealedBody.flush.pendingCount, 0);
    assert.ok(listHistoryFiles(dir).includes(sealedBody.versionId));
    assert.equal(listHistoryFiles(dir).includes(deltaBody.versionId), false);

    const folded = await authed(app, token, "POST", `/api/v1/files/${FILE}/version-urls`, {
      vault: vaultId,
      versionIds: [deltaBody.versionId],
    });
    assert.equal(folded.status, 404);
    const listed = await authed(app, token, "GET", `/api/v1/files/${FILE}/versions?vault=${encodeURIComponent("增量")}`);
    const versions = (await listed.json() as VersionListResponse).versions;
    const keptDelta = versions.find((version) => version.versionId === deltaBody.versionId);
    assert.equal(keptDelta?.kind, "delta");
    assert.equal(keptDelta?.sealed, true);
    assert.equal(keptDelta?.foldedInto, sealedBody.versionId);
    const checkpoint = await authed(app, token, "POST", `/api/v1/files/${FILE}/version-urls`, {
      vault: vaultId,
      versionIds: [sealedBody.versionId],
    });
    assert.equal(checkpoint.status, 200, await checkpoint.clone().text());
    const checkpointLink = (await checkpoint.json() as { downloads: { url: string }[] }).downloads[0];
    assert.match(await (await app.request(checkpointLink?.url ?? "")).text(), /"v":0/);

    const due = await authed(app, token, "GET", `/api/v1/vaults/${vaultId}/history-flush`);
    assert.equal(due.status, 200, await due.clone().text());
    assert.deepEqual(await due.json(), { files: [] });

    const again = await authed(app, token, "POST", `/api/v1/files/${FILE}/checkpoints`, {
      vault: vaultId,
      contentCipher: tipBody.contentCipher,
      contentMac: tipBody.contentMac,
      size: tipBody.size,
      mtime: tipBody.mtime,
      encoding: tipBody.encoding,
      tipRev: tipBody.rev,
      syncTrigger: "auto",
    });
    assert.equal(again.status, 200, await again.clone().text());
    assert.equal((await again.json() as { versionId: string }).versionId, sealedBody.versionId);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a one-day-old delta is due, and manual checkpoints are not trimmed with auto ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-history-age-"));
  const db = await openDatabase(testConfig(dir));
  const app = createApp({ config: testConfig(dir), db });
  try {
    const token = await devToken(app);
    const macs = ["c1", "c2", "c3", "c4"].map((byte) => byte.repeat(32));
    const first = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("留存", macs[0] ?? "", "v1", null, {
      syncTrigger: "auto",
      autoLimit: 1,
    }));
    assert.equal(first.status, 200, await first.clone().text());
    const opened = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("留存", macs[1] ?? "", "v2", 1, {
      syncTrigger: "auto",
      historyKind: "delta",
      patchCipher: plainPatch("aged"),
      autoLimit: 1,
    }));
    assert.equal(opened.status, 200, await opened.clone().text());
    const openedBody = await opened.json() as { versionId: string; historyKind: string; flush: { due: boolean } };
    assert.equal(openedBody.historyKind, "delta");
    assert.equal(openedBody.flush.due, false);
    await db.setVersionCreatedAt(openedBody.versionId, Date.now() - 2 * 24 * 60 * 60 * 1000);

    const vaults = await authed(app, token, "GET", "/api/v1/vaults");
    const vaultId = (await vaults.json() as { vaults: { id: string; name: string }[] }).vaults.find((vault) => vault.name === "留存")?.id ?? "";
    const due = await authed(app, token, "GET", `/api/v1/vaults/${vaultId}/history-flush`);
    const dueBody = await due.json() as { files: { fileId: string; reason: string }[] };
    assert.equal(dueBody.files.some((file) => file.fileId === FILE && file.reason === "age"), true);

    const manual = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("留存", macs[2] ?? "", "v3", 2, {
      syncTrigger: "manual",
      autoLimit: 1,
    }));
    assert.equal(manual.status, 200, await manual.clone().text());
    assert.equal((await manual.json() as { historyKind: string }).historyKind, "checkpoint");
    const auto = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("留存", macs[3] ?? "", "v4", 3, {
      syncTrigger: "auto",
      autoLimit: 1,
    }));
    assert.equal(auto.status, 200, await auto.clone().text());

    const listed = await authed(app, token, "GET", `/api/v1/files/${FILE}/versions?vault=${encodeURIComponent("留存")}`);
    const versions = (await listed.json() as VersionListResponse).versions;
    const kept = new Set(versions.map((version) => version.contentMac));
    assert.equal(kept.has(macs[0] ?? ""), false);
    assert.equal(kept.has(macs[2] ?? ""), true);
    assert.equal(kept.has(macs[3] ?? ""), true);
    assert.equal(versions.some((version) => version.syncTrigger === "manual" && version.kind === "checkpoint"), true);
    assert.equal(versions.filter((version) => version.kind === "checkpoint" && version.syncTrigger === "auto").length, 1);
    const aged = versions.find((version) => version.versionId === openedBody.versionId);
    assert.equal(aged?.sealed, true);
    assert.equal(aged?.kind, "delta");

    const quiet = await authed(app, token, "GET", `/api/v1/vaults/${vaultId}/history-flush`);
    assert.deepEqual(await quiet.json(), { files: [] });
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plaintext wipe removes plain deltas and plain checkpoints and leaves ciphertext", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-history-wipe-"));
  const db = await openDatabase(testConfig(dir));
  const app = createApp({ config: testConfig(dir), db });
  try {
    const token = await devToken(app);
    const created = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("擦除", "d1".repeat(32), "plain-tip", null, {
      syncTrigger: "manual",
    }));
    assert.equal(created.status, 200, await created.clone().text());
    const plainCheckpoint = (await created.json() as { versionId: string }).versionId;
    const delta = await authed(app, token, "PUT", `/api/v1/objects/${FILE}`, plainObject("擦除", "d2".repeat(32), "plain-next", 1, {
      syncTrigger: "auto",
      historyKind: "delta",
      patchCipher: plainPatch("plain-delta"),
    }));
    assert.equal(delta.status, 200, await delta.clone().text());
    const deltaBody = await delta.json() as { versionId: string; historyKind: string };
    const plainDelta = deltaBody.versionId;
    assert.equal(deltaBody.historyKind, "delta");

    const vaults = await authed(app, token, "GET", "/api/v1/vaults");
    const vaultId = (await vaults.json() as { vaults: { id: string; name: string }[] }).vaults.find((vault) => vault.name === "擦除")?.id ?? "";
    const blocked = await authed(app, token, "POST", `/api/v1/vaults/${vaultId}/plaintext-history`);
    assert.equal(blocked.status, 409);

    const encrypted = await authed(app, token, "PUT", `/api/v1/objects/${OTHER}`, cipherObject("擦除", "ee".repeat(32), null));
    assert.equal(encrypted.status, 200, await encrypted.clone().text());
    const cipherVersion = (await encrypted.json() as { versionId: string }).versionId;

    const wiped = await authed(app, token, "POST", `/api/v1/vaults/${vaultId}/plaintext-history`);
    assert.equal(wiped.status, 200, await wiped.clone().text());
    assert.ok((await wiped.json() as { deleted: number }).deleted >= 2);

    const plainLeft = await authed(app, token, "GET", `/api/v1/files/${FILE}/versions?vault=${encodeURIComponent("擦除")}`);
    assert.equal((await plainLeft.json() as VersionListResponse).versions.length, 0);
    const gone = await authed(app, token, "POST", `/api/v1/files/${FILE}/version-urls`, {
      vault: vaultId,
      versionIds: [plainDelta],
    });
    assert.equal(gone.status, 404);
    assert.equal(listHistoryFiles(dir).includes(plainCheckpoint), false);
    assert.equal(listHistoryFiles(dir).includes(cipherVersion), true);

    const cipherLeft = await authed(app, token, "GET", `/api/v1/files/${OTHER}/versions?vault=${encodeURIComponent("擦除")}`);
    const cipherVersions = (await cipherLeft.json() as VersionListResponse).versions;
    assert.equal(cipherVersions.length, 1);
    assert.equal(cipherVersions[0]?.encoding, "e2ee");
    assert.equal(cipherVersions[0]?.kind, "checkpoint");

    const plainTip = await authed(app, token, "GET", `/api/v1/objects/${FILE}`);
    assert.equal(plainTip.status, 200);
    assert.equal((await plainTip.json() as { encoding: string; rev: number }).rev, 2);
    const cipherTip = await authed(app, token, "GET", `/api/v1/objects/${OTHER}`);
    assert.equal((await cipherTip.json() as { encoding: string }).encoding, "e2ee");
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function listHistoryFiles(dir: string): string[] {
  const root = join(dir, "blobs");
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const account of readdirSync(root)) {
    const history = join(root, account, "history");
    if (!existsSync(history)) continue;
    found.push(...readdirSync(history));
  }
  return found;
}

function plainPatch(text: string): { v: 0; raw: string } {
  return { v: 0, raw: bytesToBase64(new TextEncoder().encode(text)) };
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = Buffer.from(value, "base64");
  return new Uint8Array(binary);
}

function plainObject(
  vault: string,
  contentMac: string,
  text: string,
  parentRev: number | null,
  history: {
    syncTrigger: "auto" | "manual";
    autoLimit?: number;
    historyKind?: "delta" | "checkpoint";
    patchCipher?: { v: 0; raw: string };
    size?: number;
  },
): Record<string, unknown> {
  const bytes = new TextEncoder().encode(text);
  return {
    vault,
    pathCipher: { v: 0, raw: bytesToBase64(new TextEncoder().encode("a.md")) },
    contentCipher: { v: 0, raw: bytesToBase64(bytes) },
    contentMac,
    size: history.size ?? bytes.byteLength,
    mtime: 1700000000000,
    encoding: "plain",
    parentRev,
    parent_rev: parentRev,
    syncTrigger: history.syncTrigger,
    ...(history.autoLimit === undefined ? {} : { autoLimit: history.autoLimit }),
    ...(history.historyKind ? { historyKind: history.historyKind } : {}),
    ...(history.patchCipher ? { patchCipher: history.patchCipher } : {}),
  };
}

function cipherObject(vault: string, contentMac: string, parentRev: number | null): Record<string, unknown> {
  return {
    vault,
    pathCipher: { v: 1, iv: "aabb", ct: "ccdd" },
    contentCipher: { v: 1, iv: "eeff", ct: "1122" },
    contentMac,
    size: 4,
    mtime: 1700000000001,
    encoding: "e2ee",
    parentRev,
    parent_rev: parentRev,
    syncTrigger: "auto",
  };
}

function testConfig(dir: string): AppConfig {
  return {
    port: 0,
    dataDir: dir,
    sessionSecret: "test-secret",
    oidc: null,
    allowDevLogin: true,
    mode: "central",
    requireEncryption: false,
    accessToken: "",
    database: { kind: "sqlite", path: join(dir, "sync.db") },
    storage: { kind: "file" },
  };
}

async function devToken(app: ReturnType<typeof createApp>): Promise<string> {
  const started = await app.request("http://127.0.0.1/api/v1/device/start", { method: "POST" });
  const { deviceCode } = await started.json() as { deviceCode: string };
  await app.request("http://127.0.0.1/auth/dev/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "history-user", device: deviceCode }).toString(),
    redirect: "manual",
  });
  const polled = await app.request(`http://127.0.0.1/api/v1/device/poll?code=${encodeURIComponent(deviceCode)}`);
  return (await polled.json() as { apiToken: string }).apiToken;
}

async function authed(
  app: ReturnType<typeof createApp>,
  token: string,
  method: string,
  path: string,
  payload?: unknown,
): Promise<Response> {
  const bodyText = payload === undefined ? "" : JSON.stringify(payload);
  return app.request(`http://127.0.0.1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(bodyText ? { "content-type": "application/json" } : {}),
    },
    body: bodyText || undefined,
  });
}
