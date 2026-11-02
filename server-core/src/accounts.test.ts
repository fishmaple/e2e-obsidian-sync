import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentMac, encryptBytes, fileIdForPath, deriveKeys } from "../../shared/src/crypto";
import { createApp } from "./app";
import type { AppConfig } from "./config";
import { openDatabase } from "./db";
import { sweepExpiredUploads } from "./maintenance";
import { hashPassword } from "./passwords";

test("password login, rename, trash, limits, and session expiry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "siltquill-"));
  const config = testConfig(dir);
  const db = await openDatabase(config);
  const hashed = await hashPassword("correct-horse");
  const account = await db.upsertAccount("login:ada", "ada");
  await db.insertLogin("ada", account.id, hashed.hash, hashed.salt);
  const app = createApp({ config, db });
  try {
    const denied = await app.request("http://127.0.0.1/api/v1/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginId: "ada", password: "wrong-password" }),
    });
    assert.equal(denied.status, 401);

    const login = await app.request("http://127.0.0.1/api/v1/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginId: "ada", password: "correct-horse" }),
    });
    assert.equal(login.status, 200);
    const session = await login.json() as { apiToken: string; displayName: string };
    assert.equal(session.displayName, "ada");

    const keys = await deriveKeys("this-is-a-long-secret");
    const vault = "notes";
    const path = "a.md";
    const plain = new TextEncoder().encode("hello");
    const fileId = await fileIdForPath(keys.idKey, path, vault);
    const mac = await contentMac(keys.idKey, plain);
    const pathMac = await contentMac(keys.idKey, new TextEncoder().encode(path));
    const payload = {
      vault,
      pathCipher: await encryptBytes(keys.encKey, new TextEncoder().encode(path), `path:${fileId}`),
      contentCipher: await encryptBytes(keys.encKey, plain, `body:${fileId}`),
      contentMac: mac,
      pathMac,
      size: plain.byteLength,
      mtime: 1,
      encoding: "e2ee" as const,
    };
    const created = await authed(app, session.apiToken, "PUT", `/api/v1/objects/${fileId}`, payload);
    assert.equal(created.status, 200);
    const first = await created.json() as { rev: number };

    const renamedPath = "b.md";
    const renamed = await authed(app, session.apiToken, "PUT", `/api/v1/objects/${fileId}`, {
      ...payload,
      pathCipher: await encryptBytes(keys.encKey, new TextEncoder().encode(renamedPath), `path:${fileId}`),
      pathMac: await contentMac(keys.idKey, new TextEncoder().encode(renamedPath)),
      renamed: true,
      parentRev: first.rev,
    });
    assert.equal(renamed.status, 200);
    const second = await renamed.json() as { rev: number };
    assert.equal(second.rev, first.rev + 1);

    const vaults = await authed(app, session.apiToken, "GET", "/api/v1/vaults");
    const listed = await vaults.json() as { vaults: { id: string }[] };
    const vaultId = listed.vaults[0]?.id ?? "";
    const limited = await authed(app, session.apiToken, "POST", "/api/v1/policy", {
      trashDays: 30,
      trashMaxFiles: 200,
      vaultId,
      maxFiles: 1,
      maxBytes: 0,
    });
    assert.equal(limited.status, 200);
    const otherId = await fileIdForPath(keys.idKey, "c.md", vault);
    const blocked = await authed(app, session.apiToken, "PUT", `/api/v1/objects/${otherId}`, {
      ...payload,
      pathCipher: await encryptBytes(keys.encKey, new TextEncoder().encode("c.md"), `path:${otherId}`),
      contentCipher: await encryptBytes(keys.encKey, plain, `body:${otherId}`),
      pathMac: await contentMac(keys.idKey, new TextEncoder().encode("c.md")),
    });
    assert.equal(blocked.status, 413);

    const deleted = await authed(app, session.apiToken, "POST", "/api/v1/deletions", {
      vault,
      ids: [fileId],
      localCount: 1,
    });
    assert.equal(deleted.status, 200);
    const trash = await authed(app, session.apiToken, "GET", `/api/v1/trash?vault=${encodeURIComponent(vaultId)}`);
    assert.equal(trash.status, 200);
    const trashBody = await trash.json() as { items: { fileId: string }[] };
    assert.equal(trashBody.items[0]?.fileId, fileId);
    const restored = await authed(app, session.apiToken, "POST", `/api/v1/trash/${fileId}/restore`, { vaultId });
    assert.equal(restored.status, 200);

    await db.putUploadGrant(account.id, fileId, 10, "server", Date.now() - 1000);
    assert.equal(await sweepExpiredUploads(config, db), 1);
    assert.equal(await db.getUploadGrant(account.id, fileId), undefined);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("api tokens expire", async () => {
  const dir = mkdtempSync(join(tmpdir(), "siltquill-ttl-"));
  const config = testConfig(dir, { sessionTtlMs: 40 });
  const db = await openDatabase(config);
  const hashed = await hashPassword("correct-horse");
  const account = await db.upsertAccount("login:bea", "bea");
  await db.insertLogin("bea", account.id, hashed.hash, hashed.salt);
  const app = createApp({ config, db });
  try {
    const login = await app.request("http://127.0.0.1/api/v1/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginId: "bea", password: "correct-horse" }),
    });
    const session = await login.json() as { apiToken: string };
    const fresh = await authed(app, session.apiToken, "GET", "/api/v1/vaults");
    assert.equal(fresh.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const stale = await authed(app, session.apiToken, "GET", "/api/v1/vaults");
    assert.equal(stale.status, 401);
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
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    adminKey: "test-admin",
    ...extra,
  };
}

function authed(app: ReturnType<typeof createApp>, token: string, method: string, path: string, payload?: unknown): Promise<Response> {
  return Promise.resolve(app.request(`http://127.0.0.1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }));
}
