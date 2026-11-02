import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bytesToBase64 } from "../../shared/src/codec";
import { groupVersionsByDay, type RetentionView, type VersionListResponse } from "../../shared/src/history";
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

function bytesFromBase64(value: string): Uint8Array {
  const binary = Buffer.from(value, "base64");
  return new Uint8Array(binary);
}

function plainObject(
  vault: string,
  contentMac: string,
  text: string,
  parentRev: number | null,
  history: { syncTrigger: "auto" | "manual"; autoLimit?: number },
): Record<string, unknown> {
  const bytes = new TextEncoder().encode(text);
  return {
    vault,
    pathCipher: { v: 0, raw: bytesToBase64(new TextEncoder().encode("a.md")) },
    contentCipher: { v: 0, raw: bytesToBase64(bytes) },
    contentMac,
    size: bytes.byteLength,
    mtime: 1700000000000,
    encoding: "plain",
    parentRev,
    parent_rev: parentRev,
    syncTrigger: history.syncTrigger,
    ...(history.autoLimit === undefined ? {} : { autoLimit: history.autoLimit }),
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
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    adminKey: "test-admin",
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
