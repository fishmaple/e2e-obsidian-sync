import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bytesToBase64 } from "../../shared/src/codec";
import { contentMac, decryptBytes, deriveKeys, encryptBytes, fileIdForPath, openBytes } from "../../shared/src/crypto";
import type { Envelope, Manifest } from "../../shared/src/protocol";
import { createApp } from "./app";
import type { AppConfig } from "./config";
import { openDatabase } from "./db";

test("logged-in users can see stats and upload without sending the key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-sync-"));
  const config = testConfig(dir);
  const db = await openDatabase(config);
  const app = createApp({ config, db });
  try {
    const health = await app.request("http://127.0.0.1/api/v1/health");
    assert.equal(health.status, 200);

    const started = await app.request("http://127.0.0.1/api/v1/device/start", { method: "POST" });
    assert.equal(started.status, 200);
    const { deviceCode } = await started.json() as { deviceCode: string };

    const pending = await app.request(`http://127.0.0.1/api/v1/device/poll?code=${encodeURIComponent(deviceCode)}`);
    assert.equal(pending.status, 202);

    const login = await app.request("http://127.0.0.1/auth/dev/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "alice", device: deviceCode }).toString(),
      redirect: "manual",
    });
    assert.equal(login.status, 302);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    assert.ok(cookie.startsWith("sync_session="));

    const polled = await app.request(`http://127.0.0.1/api/v1/device/poll?code=${encodeURIComponent(deviceCode)}`);
    assert.equal(polled.status, 200);
    const { accountId, apiToken } = await polled.json() as { accountId: string; apiToken: string };
    assert.ok(apiToken);

    const page = await app.request("http://127.0.0.1/account", { headers: { cookie } });
    assert.match(await page.text(), /还没有上传/);

    const secret = "this-is-a-long-secret";
    const keys = await deriveKeys(secret);
    const vault = "日记";
    const path = "日记/今天.md";
    const plain = new TextEncoder().encode("只有这台设备看得懂");
    const fileId = await fileIdForPath(keys.idKey, path, vault);
    const payload = {
      vault,
      pathCipher: await encryptBytes(keys.encKey, new TextEncoder().encode(path), `path:${fileId}`),
      contentCipher: await encryptBytes(keys.encKey, plain, `body:${fileId}`),
      contentMac: await contentMac(keys.idKey, plain),
      size: plain.byteLength,
      mtime: 1700000000000,
      encoding: "e2ee" as const,
    };
    const put = await authed(app, apiToken, "PUT", `/api/v1/objects/${fileId}`, payload);
    assert.equal(put.status, 200, await put.text());

    const otherId = await fileIdForPath(keys.idKey, "另一篇.md", "另一库");
    const other = await authed(app, apiToken, "PUT", `/api/v1/objects/${otherId}`, {
      ...payload,
      vault: "另一库",
      pathCipher: await encryptBytes(keys.encKey, new TextEncoder().encode("另一篇.md"), `path:${otherId}`),
      contentCipher: await encryptBytes(keys.encKey, plain, `body:${otherId}`),
    });
    assert.equal(other.status, 200, await other.text());

    const stats = await app.request("http://127.0.0.1/account", { headers: { cookie } });
    const html = await stats.text();
    assert.match(html, /日记/);
    assert.match(html, /另一库/);
    assert.match(html, /2 个库，2 篇笔记/);

    const manifestRes = await authed(app, apiToken, "GET", `/api/v1/manifest?vault=${encodeURIComponent(vault)}`);
    assert.equal(manifestRes.status, 200);
    const manifest = await manifestRes.json() as Manifest;
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0]?.contentMac, payload.contentMac);
    assert.equal(manifest.files[0]?.encoding, "e2ee");

    const got = await authed(app, apiToken, "GET", `/api/v1/objects/${fileId}`);
    const stored = await got.json() as { pathCipher: Envelope; contentCipher: Envelope };
    const restored = await decryptBytes(keys.encKey, stored.contentCipher, `body:${fileId}`);
    assert.equal(new TextDecoder().decode(restored), "只有这台设备看得懂");

    const wiped = await authed(app, apiToken, "POST", "/api/v1/deletions", {
      vault,
      ids: [fileId],
      localCount: 0,
    });
    assert.equal(wiped.status, 200);

    const removed = await authed(app, apiToken, "POST", "/api/v1/deletions", {
      vault,
      ids: [fileId],
      localCount: 3,
    });
    assert.equal(removed.status, 200);
    const after = await authed(app, apiToken, "GET", `/api/v1/manifest?vault=${encodeURIComponent(vault)}`);
    const afterManifest = await after.json() as Manifest;
    assert.equal(afterManifest.files.length, 0);
    const kept = await authed(app, apiToken, "GET", "/api/v1/manifest?vault=%E5%8F%A6%E4%B8%80%E5%BA%93");
    const keptManifest = await kept.json() as Manifest;
    assert.equal(keptManifest.files.length, 1);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("developer login still succeeds when origin is null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-origin-"));
  const config = testConfig(dir);
  const db = await openDatabase(config);
  const app = createApp({ config, db });
  try {
    const login = await app.request("http://127.0.0.1/auth/dev/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "null",
        host: "127.0.0.1",
      },
      body: new URLSearchParams({ username: "alice" }).toString(),
      redirect: "manual",
    });
    assert.equal(login.status, 302);
    assert.match(login.headers.get("set-cookie") ?? "", /sync_session=/);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("login returns to Obsidian and the code can be exchanged once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-return-"));
  const config = testConfig(dir);
  const db = await openDatabase(config);
  const app = createApp({ config, db });
  try {
    const state = "a".repeat(32);
    const login = await app.request("http://127.0.0.1/auth/dev/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "127.0.0.1" },
      body: new URLSearchParams({ username: "carol", return: "obsidian", state, vault: "AI学习笔记" }).toString(),
    });
    const html = await login.text();
    assert.equal(login.status, 200, html);
    assert.match(login.headers.get("set-cookie") ?? "", /sync_session=/);
    assert.match(html, /obsidian:\/\/e2ee-sync\?code=/);
    assert.match(html, /AI%E5%AD%A6%E4%B9%A0%E7%AC%94%E8%AE%B0|AI学习笔记/);
    const code = html.match(/code=([A-Za-z0-9_-]+)/)?.[1] ?? "";
    assert.ok(code);
    const exchanged = await app.request("http://127.0.0.1/api/v1/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, state }),
    });
    const body = await exchanged.json() as { accountId: string; apiToken: string; displayName: string };
    assert.equal(exchanged.status, 200);
    assert.ok(body.accountId);
    assert.ok(body.apiToken);
    assert.equal(body.displayName, "carol");
    const again = await app.request("http://127.0.0.1/api/v1/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, state }),
    });
    assert.equal(again.status, 400);

    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const state2 = "b".repeat(32);
    const bounce = await app.request(`http://127.0.0.1/login?return=obsidian&state=${state2}`, {
      headers: { cookie },
    });
    assert.equal(bounce.status, 200);
    assert.match(await bounce.text(), /obsidian:\/\/e2ee-sync\?code=/);

    const web = await app.request("http://127.0.0.1/api/v1/web-session", {
      method: "POST",
      headers: { authorization: `Bearer ${body.apiToken}` },
    });
    assert.equal(web.status, 200);
    const { code: webCode } = await web.json() as { code: string };
    const enter = await app.request(`http://127.0.0.1/account/enter?code=${encodeURIComponent(webCode)}`, {
      redirect: "manual",
    });
    assert.equal(enter.status, 302);
    assert.equal(enter.headers.get("location"), "/account");
    const site = await app.request("http://127.0.0.1/account", {
      headers: { cookie: (enter.headers.get("set-cookie") ?? "").split(";")[0] ?? "" },
    });
    assert.match(await site.text(), /上传情况/);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("single-account mode issues an account id and plaintext follows configuration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-single-"));
  const config = testConfig(dir, { mode: "single", requireEncryption: false, storage: { kind: "database" } });
  const db = await openDatabase(config);
  const app = createApp({ config, db });
  try {
    const boot = await app.request("http://127.0.0.1/api/v1/bootstrap");
    assert.equal(boot.status, 200);
    const body = await boot.json() as { mode: string; accountId: string; registration: boolean; apiToken?: string };
    assert.equal(body.mode, "single");
    assert.equal(body.registration, false);
    assert.ok(body.accountId);
    assert.equal(body.apiToken, undefined);

    const issued = await app.request("http://127.0.0.1/api/v1/bootstrap?issue=1");
    const issuedBody = await issued.json() as { apiToken?: string };
    assert.ok(issuedBody.apiToken);

    const page = await app.request("http://127.0.0.1/account");
    assert.equal(page.status, 200);
    assert.match(await page.text(), new RegExp(body.accountId));

    const keys = await deriveKeys("this-is-a-long-secret");
    const plain = new TextEncoder().encode("明文笔记");
    const fileId = await fileIdForPath(keys.idKey, "a.md", "笔记");
    const payload = {
      vault: "笔记",
      pathCipher: { v: 0, raw: bytesToBase64(new TextEncoder().encode("a.md")) },
      contentCipher: { v: 0, raw: bytesToBase64(plain) },
      contentMac: await contentMac(keys.idKey, plain),
      size: plain.byteLength,
      mtime: 1,
      encoding: "plain",
    };
    const put = await authed(app, issuedBody.apiToken, "PUT", `/api/v1/objects/${fileId}`, payload);
    assert.equal(put.status, 200, await put.text());
    assert.equal(existsSync(join(dir, "blobs")), false);
    const got = await authed(app, issuedBody.apiToken, "GET", `/api/v1/objects/${fileId}`);
    const stored = await got.json() as { contentCipher: { v: 0; raw: string } };
    const restored = await openBytes(keys.encKey, stored.contentCipher, `body:${fileId}`);
    assert.equal(new TextDecoder().decode(restored), "明文笔记");
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a central server rejects plaintext by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-lock-"));
  const config = testConfig(dir);
  const db = await openDatabase(config);
  const app = createApp({ config, db });
  try {
    const login = await app.request("http://127.0.0.1/auth/dev/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "bob" }).toString(),
      redirect: "manual",
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const started = await app.request("http://127.0.0.1/api/v1/device/start", { method: "POST" });
    const { deviceCode } = await started.json() as { deviceCode: string };
    await app.request("http://127.0.0.1/auth/dev/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ username: "bob", device: deviceCode }).toString(),
      redirect: "manual",
    });
    const polled = await app.request(`http://127.0.0.1/api/v1/device/poll?code=${encodeURIComponent(deviceCode)}`);
    const { apiToken } = await polled.json() as { apiToken: string };
    const put = await authed(app, apiToken, "PUT", `/api/v1/objects/${"ab".repeat(32)}`, {
      vault: "笔记",
      pathCipher: { v: 0, raw: bytesToBase64(new TextEncoder().encode("a.md")) },
      contentCipher: { v: 0, raw: bytesToBase64(new TextEncoder().encode("x")) },
      contentMac: "ab".repeat(32),
      size: 1,
      mtime: 1,
      encoding: "plain",
    });
    assert.equal(put.status, 400, await put.text());
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plaintext vault accepts uploads until encryption is locked, and logout revokes the token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-sync-"));
  const db = await openDatabase(testConfig(dir, { requireEncryption: false }));
  const app = createApp({ config: testConfig(dir, { requireEncryption: false }), db });
  try {
    const started = await app.request("http://127.0.0.1/api/v1/device/start", { method: "POST" });
    const { deviceCode } = await started.json() as { deviceCode: string };
    await app.request("http://127.0.0.1/auth/dev/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "bob", device: deviceCode }).toString(),
      redirect: "manual",
    });
    const polled = await app.request(`http://127.0.0.1/api/v1/device/poll?code=${encodeURIComponent(deviceCode)}`);
    const { apiToken } = await polled.json() as { apiToken: string };
    const fileId = "ab".repeat(32);
    const plain = {
      vault: "新库",
      pathCipher: { v: 0, raw: bytesToBase64(new TextEncoder().encode("a.md")) },
      contentCipher: { v: 0, raw: bytesToBase64(new TextEncoder().encode("hi")) },
      contentMac: "cd".repeat(32),
      size: 2,
      mtime: 1,
      encoding: "plain" as const,
    };
    const created = await authed(app, apiToken, "POST", "/api/v1/vaults", { name: "新库", create: true });
    assert.equal(created.status, 200);
    const createdBody = await created.json() as { id: string; encrypted: boolean };
    assert.equal(createdBody.encrypted, false);
    assert.match(createdBody.id, /^[0-9a-f-]{36}$/i);
    const duplicate = await authed(app, apiToken, "POST", "/api/v1/vaults", { name: "新库", create: true });
    assert.equal(duplicate.status, 409);

    const put = await authed(app, apiToken, "PUT", `/api/v1/objects/${fileId}`, plain);
    assert.equal(put.status, 200, await put.text());

    const secret = "this-is-a-long-secret";
    const keys = await deriveKeys(secret);
    const encryptedId = await fileIdForPath(keys.idKey, "a.md", "新库");
    const body = new TextEncoder().encode("hi");
    const sealed = await authed(app, apiToken, "PUT", `/api/v1/objects/${encryptedId}`, {
      vault: "新库",
      pathCipher: await encryptBytes(keys.encKey, new TextEncoder().encode("a.md"), `path:${encryptedId}`),
      contentCipher: await encryptBytes(keys.encKey, body, `body:${encryptedId}`),
      contentMac: await contentMac(keys.idKey, body),
      size: body.byteLength,
      mtime: 2,
      encoding: "e2ee",
    });
    assert.equal(sealed.status, 200, await sealed.text());

    const rejected = await authed(app, apiToken, "PUT", `/api/v1/objects/${"ef".repeat(32)}`, plain);
    const rejectedText = await rejected.text();
    assert.equal(rejected.status, 409, rejectedText);

    const listed = await authed(app, apiToken, "GET", "/api/v1/vaults");
    const vaults = (await listed.json() as { vaults: Array<{ name: string; encrypted: boolean }> }).vaults;
    assert.equal(vaults.find((vault) => vault.name === "新库")?.encrypted, true);

    const logout = await authed(app, apiToken, "POST", "/api/v1/logout");
    assert.equal(logout.status, 200);
    const again = await authed(app, apiToken, "GET", "/api/v1/vaults");
    assert.equal(again.status, 401);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the home page links to install, and a remote vault can be marked encrypted first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-sync-"));
  const db = await openDatabase(testConfig(dir, { requireEncryption: false }));
  const app = createApp({ config: testConfig(dir, { requireEncryption: false }), db });
  try {
    const home = await app.request("http://127.0.0.1/");
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /favicon\.png/);
    assert.match(html, /同步情况/);
    assert.match(html, /obsidian\.md/);
    const install = await app.request("http://127.0.0.1/install");
    assert.equal(install.status, 200);
    assert.match(await install.text(), /install\.ps1/);
    const icon = await app.request("http://127.0.0.1/favicon.ico");
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type") ?? "", /image\/png/);
    const script = await app.request("http://127.0.0.1/install.ps1");
    const ps1 = await script.text();
    assert.match(ps1, /community-plugins\.json/);
    assert.match(ps1, /SHA256SUMS/);
    assert.doesNotMatch(ps1, /\$list\.Count -eq 1/);
    const sh = await (await app.request("http://127.0.0.1/install.sh")).text();
    assert.match(sh, /curl --retry 3/);
    assert.match(sh, /SHA256SUMS/);
    assert.doesNotMatch(sh, /urlretrieve/);
    const latest = await app.request("http://127.0.0.1/plugin/e2ee-sync/latest");
    assert.equal(latest.status, 200);
    assert.equal((await latest.text()).trim(), "0.3.0-beta");
    const sums = await app.request("http://127.0.0.1/plugin/e2ee-sync/0.3.0-beta/SHA256SUMS");
    assert.equal(sums.status, 200);
    assert.match(await sums.text(), /[0-9a-f]{64}  main\.js/);
    const account = await app.request("http://127.0.0.1/install");
    assert.match(await account.text(), /CERTIFICATE_VERIFY_FAILED/);

    const started = await app.request("http://127.0.0.1/api/v1/device/start", { method: "POST" });
    const { deviceCode } = await started.json() as { deviceCode: string };
    await app.request("http://127.0.0.1/auth/dev/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "cara", device: deviceCode }).toString(),
      redirect: "manual",
    });
    const polled = await app.request(`http://127.0.0.1/api/v1/device/poll?code=${encodeURIComponent(deviceCode)}`);
    const { apiToken } = await polled.json() as { apiToken: string };
    const locked = await authed(app, apiToken, "POST", "/api/v1/vaults", { name: "锁库", encrypted: true });
    assert.equal((await locked.json() as { encrypted: boolean }).encrypted, true);
    const blocked = await authed(app, apiToken, "PUT", `/api/v1/objects/${"11".repeat(32)}`, {
      vault: "锁库",
      pathCipher: { v: 0, raw: bytesToBase64(new TextEncoder().encode("a.md")) },
      contentCipher: { v: 0, raw: bytesToBase64(new TextEncoder().encode("hi")) },
      contentMac: "cd".repeat(32),
      size: 2,
      mtime: 1,
      encoding: "plain",
    });
    assert.equal(blocked.status, 409);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function testConfig(dir: string, extra: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    dataDir: dir,
    sessionSecret: "test-secret",
    oidc: null,
    allowDevLogin: true,
    mode: "central",
    requireEncryption: true,
    accessToken: "",
    database: { kind: "sqlite", path: join(dir, "sync.db") },
    storage: { kind: "file" },
    ...extra,
  };
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
