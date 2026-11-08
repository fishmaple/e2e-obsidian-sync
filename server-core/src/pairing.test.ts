import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PAIRING_TTL_MS } from "../../shared/src/protocol";
import { createApp } from "./app";
import type { AppConfig } from "./config";
import { openDatabase } from "./db";
import { hashPassword } from "./passwords";

const DISPLAY_CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
const REDEEM_ERROR = "The pairing code is invalid or expired";

test("pairing create requires auth, and redeem is single-use within the TTL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-pair-"));
  const config = testConfig(dir);
  const db = await openDatabase(config);
  const app = createApp({ config, db });
  const logged: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const anonymous = await app.request("http://127.0.0.1/api/v1/pairing/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(anonymous.status, 401);

    const aliceLogin = await devLogin(app, "alice");
    const alice = await accountFromSession(app, aliceLogin.cookie);
    const bobHashed = await hashPassword("bob-password");
    const bob = await db.upsertAccount("login:bob", "bob");
    await db.insertLogin("bob", bob.id, bobHashed.hash, bobHashed.salt);
    const bobLogin = await app.request("http://127.0.0.1/api/v1/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginId: "bob", password: "bob-password" }),
    });
    assert.equal(bobLogin.status, 200);
    const bobSession = await bobLogin.json() as { accountId: string; apiToken: string; displayName: string };
    assert.equal(bobSession.accountId, bob.id);

    const cross = await create(app, aliceLogin.cookie, { accountId: bob.id });
    assert.equal(cross.accountId, alice.accountId);
    assert.match(cross.code, DISPLAY_CODE);
    assert.ok(cross.expiresAt - Date.now() <= PAIRING_TTL_MS);
    assert.ok(cross.expiresAt - Date.now() > PAIRING_TTL_MS - 5_000);

    const bearer = await app.request("http://127.0.0.1/api/v1/pairing/create", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bobSession.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ accountId: alice.accountId }),
    });
    assert.equal(bearer.status, 200);
    const bobCode = await bearer.json() as PairingIssue;
    assert.equal(bobCode.accountId, bob.id);

    const adminLogin = await app.request("http://127.0.0.1/admin/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "127.0.0.1" },
      body: new URLSearchParams({ key: "test-admin" }).toString(),
      redirect: "manual",
    });
    assert.equal(adminLogin.status, 302);
    const adminCookie = cookieOf(adminLogin);
    const missing = await app.request("http://127.0.0.1/api/v1/pairing/create", {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ accountId: "missing-account" }),
    });
    assert.equal(missing.status, 404);
    const adminIssued = await create(app, adminCookie, { accountId: alice.accountId });
    assert.equal(adminIssued.accountId, alice.accountId);
    assert.notEqual(adminIssued.code, cross.code);

    const stale = await redeem(app, cross.code);
    assert.equal(stale.status, 400);
    assert.equal((await stale.json() as { error: string }).error, REDEEM_ERROR);

    const redeemed = await redeem(app, `  ${bobCode.code.toLowerCase()} `);
    assert.equal(redeemed.status, 200);
    const session = await redeemed.json() as { accountId: string; displayName: string; apiToken: string };
    assert.equal(session.accountId, bob.id);
    assert.equal(session.displayName, "bob");
    assert.ok(session.apiToken);
    const profile = await app.request("http://127.0.0.1/api/v1/account", {
      headers: { authorization: `Bearer ${session.apiToken}` },
    });
    assert.equal(profile.status, 200);

    const again = await redeem(app, bobCode.code.replace("-", ""));
    assert.equal(again.status, 400);
    assert.equal((await again.json() as { error: string }).error, REDEEM_ERROR);

    await db.replacePairingCode(alice.accountId, "ABCDEFGH", Date.now() - 1_000);
    const expired = await redeem(app, "ABCD-EFGH");
    assert.equal(expired.status, 400);
    const expiredAgain = await redeem(app, "ABCDEFGH");
    assert.equal(expiredAgain.status, 400);

    const garbage = await redeem(app, "not a code");
    assert.equal(garbage.status, 400);
    assert.equal(await garbage.text(), JSON.stringify({ error: REDEEM_ERROR }));
    assert.equal(logged.some((line) => line.includes("ABCDEFGH") || line.includes(bobCode.code) || line.includes("not a code")), false);

    const accountPage = await app.request("http://127.0.0.1/account", { headers: { cookie: aliceLogin.cookie } });
    assert.match(await accountPage.text(), /生成匹配码/);
    const adminPage = await app.request("http://127.0.0.1/admin", { headers: { cookie: adminCookie } });
    assert.match(await adminPage.text(), /生成匹配码/);
    const instructions = await app.request("http://127.0.0.1/pair");
    assert.equal(instructions.status, 200);
    const guide = await instructions.text();
    assert.match(guide, /怎么生成/);
    assert.match(guide, /用匹配码登录/);
    assert.doesNotMatch(guide, /id="pairing-code"/);

    const posted = await app.request("http://127.0.0.1/pair", {
      method: "POST",
      headers: {
        cookie: aliceLogin.cookie,
        "content-type": "application/x-www-form-urlencoded",
        host: "127.0.0.1",
      },
      body: new URLSearchParams({ accountId: bob.id }).toString(),
      redirect: "manual",
    });
    assert.equal(posted.status, 302);
    assert.equal(posted.headers.get("location"), "/pair");
    const flash = cookieOf(posted);
    assert.match(flash, /^sync_pairing=/);
    const shown = await app.request("http://127.0.0.1/pair", { headers: { cookie: flash } });
    assert.equal(shown.headers.get("cache-control"), "no-store");
    assert.match(shown.headers.get("set-cookie") ?? "", /sync_pairing=;/);
    const html = await shown.text();
    const visible = html.match(/id="pairing-code">([^<]+)</)?.[1] ?? "";
    assert.match(visible, DISPLAY_CODE);
    const hidden = await app.request("http://127.0.0.1/pair");
    assert.doesNotMatch(await hidden.text(), new RegExp(visible));

    const locked = await app.request("http://127.0.0.1/pair", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "127.0.0.1" },
      body: "",
      redirect: "manual",
    });
    assert.equal(locked.status, 302);
    assert.equal(locked.headers.get("location"), "/login");
  } finally {
    console.error = originalError;
    console.log = originalLog;
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("single-account mode can mint a pairing code for its only account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-pair-single-"));
  const config = testConfig(dir);
  config.mode = "single";
  config.accessToken = "gate";
  const db = await openDatabase(config);
  const app = createApp({ config, db });
  try {
    const blocked = await app.request("http://127.0.0.1/api/v1/pairing/create", { method: "POST" });
    assert.equal(blocked.status, 401);
    const created = await app.request("http://127.0.0.1/api/v1/pairing/create", {
      method: "POST",
      headers: { "x-access-token": "gate" },
    });
    assert.equal(created.status, 200);
    const issued = await created.json() as PairingIssue;
    assert.match(issued.code, DISPLAY_CODE);
    assert.equal(issued.accountId, (await db.ensureSingleAccount()).id);
    const redeemed = await redeem(app, issued.code);
    assert.equal(redeemed.status, 200);
    const session = await redeemed.json() as { accountId: string; apiToken: string };
    assert.equal(session.accountId, issued.accountId);
    assert.ok(session.apiToken);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pairing redeem stops after too many attempts and does not consume a code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2ee-pair-limit-"));
  const config = testConfig(dir);
  const db = await openDatabase(config);
  const app = createApp({ config, db });
  try {
    const login = await devLogin(app, "cara");
    const issued = await create(app, login.cookie, {});
    for (let i = 0; i < 100; i++) {
      const denied = await redeem(app, "ZZZZ-ZZZZ");
      assert.equal(denied.status, 400);
    }
    const limited = await redeem(app, issued.code);
    assert.equal(limited.status, 429);
    const compact = issued.code.replace("-", "");
    assert.equal(await db.takePairingCode(compact), issued.accountId);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

interface PairingIssue {
  code: string;
  expiresAt: number;
  accountId: string;
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

async function devLogin(app: ReturnType<typeof createApp>, username: string): Promise<{ cookie: string }> {
  const login = await app.request("http://127.0.0.1/auth/dev/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", host: "127.0.0.1" },
    body: new URLSearchParams({ username }).toString(),
    redirect: "manual",
  });
  assert.equal(login.status, 302);
  return { cookie: cookieOf(login) };
}

async function accountFromSession(app: ReturnType<typeof createApp>, cookie: string): Promise<{ accountId: string }> {
  const page = await app.request("http://127.0.0.1/account", { headers: { cookie } });
  const html = await page.text();
  const accountId = html.match(/id="account-id">([^<]+)</)?.[1]?.trim() ?? "";
  assert.ok(accountId);
  return { accountId };
}

async function create(app: ReturnType<typeof createApp>, cookie: string, body: { accountId?: string }): Promise<PairingIssue> {
  const response = await app.request("http://127.0.0.1/api/v1/pairing/create", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<PairingIssue>;
}

function redeem(app: ReturnType<typeof createApp>, code: string): Promise<Response> {
  return Promise.resolve(app.request("http://127.0.0.1/api/v1/pairing/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  }));
}

function cookieOf(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}
