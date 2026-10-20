import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { bytesToBase64Url, randomBytes } from "../../shared/src/codec";
import {
  DEVICE_TTL_MS,
  MAX_BODY_BYTES,
  MAX_FILE_BYTES,
  PROTOCOL_VERSION,
  type Encoding,
  type ObjectPayload,
  type PayloadCipher,
} from "../../shared/src/protocol";
import type { AppConfig } from "./config";
import type { SyncDb } from "./db";
import { accessPage, accountPage, homePage, installPage, installPs1, installSh, loginPage, messagePage, obsidianReturnPage } from "./html";
import { createBlobStore } from "./storage";
import { completeOidcLogin, createOidcRequest } from "./oidc";
import { clearCookieHeader, openSession, readCookie, sealSession, sessionCookieName, setCookieHeader } from "./session";

const FILE_ID = /^[0-9a-f]{64}$/;
const DEVICE_CODE = /^[A-Za-z0-9_-]{32,128}$/;
const LOGIN_STATE = /^[A-Za-z0-9_-]{22,128}$/;
const USERNAME = /^[^\u0000-\u001f\u007f]{2,64}$/;
const VAULT_NAME = /^[^\u0000-\u001f\u007f\\/]{1,120}$/;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface AppDeps {
  config: AppConfig;
  db: SyncDb;
}

export function createApp(deps: AppDeps): Hono {
  const { config, db } = deps;
  const blobs = createBlobStore(config, db);
  const app = new Hono();
  let deviceStarts: number[] = [];

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
  });

  app.get("/favicon.png", (c) => iconResponse(c));
  app.get("/favicon.ico", (c) => iconResponse(c));

  app.get("/", (c) => {
    if (config.mode === "single") return c.redirect("/account");
    return c.html(homePage({ loggedIn: Boolean(sessionAccount(c)) }));
  });

  app.get("/install", (c) => {
    return c.html(installPage(publicOrigin(c)));
  });

  app.get("/install.ps1", (c) => {
    c.header("content-type", "text/plain; charset=utf-8");
    return c.body(installPs1(publicOrigin(c)));
  });

  app.get("/install.sh", (c) => {
    c.header("content-type", "text/plain; charset=utf-8");
    return c.body(installSh(publicOrigin(c)));
  });

  app.get("/plugin/e2ee-sync/latest", (c) => {
    const version = pluginVersion();
    if (!version) throw new HttpError(404, "Plugin files are not on the server");
    c.header("content-type", "text/plain; charset=utf-8");
    c.header("cache-control", "no-cache");
    return c.body(`${version}\n`);
  });

  app.get("/plugin/e2ee-sync/:version/:name", (c) => {
    const version = c.req.param("version");
    if (!/^\d+\.\d+\.\d+(?:-beta(?:\.\d+)?)?$/.test(version) || version !== pluginVersion()) {
      throw new HttpError(404, "Unknown version");
    }
    const name = c.req.param("name");
    if (name === "SHA256SUMS") {
      const sums = pluginChecksums();
      if (!sums) throw new HttpError(404, "Plugin files are not on the server");
      c.header("content-type", "text/plain; charset=utf-8");
      c.header("cache-control", "no-cache");
      return c.body(sums);
    }
    return pluginFile(c, name);
  });

  app.get("/plugin/e2ee-sync/:name", (c) => pluginFile(c, c.req.param("name")));

  app.get("/login", async (c) => {
    if (config.mode === "single") return c.redirect("/account");
    const handoff = handoffFrom(c.req.query("return"), c.req.query("state"), c.req.query("device"), c.req.query("vault"));
    const accountId = sessionAccount(c);
    if (accountId) {
      if (handoff.startsWith("obsidian:")) return finishLogin(c, accountId, handoff);
      return c.redirect("/account");
    }
    return c.html(loginPage({
      ...loginView(c.req.query("return"), c.req.query("state"), c.req.query("device"), c.req.query("vault")),
      oidc: Boolean(config.oidc),
      devLogin: config.allowDevLogin,
    }));
  });

  app.post("/auth/dev/login", async (c) => {
    if (!config.allowDevLogin) throw new HttpError(404, "Developer login is disabled");
    assertSameOrigin(c);
    const form = await c.req.parseBody();
    const username = String(form.username ?? "").trim();
    const handoff = handoffFrom(String(form.return ?? ""), String(form.state ?? ""), String(form.device ?? ""), String(form.vault ?? ""));
    if (!USERNAME.test(username)) {
      return c.html(loginPage({
        ...loginView(String(form.return ?? ""), String(form.state ?? ""), String(form.device ?? ""), String(form.vault ?? "")),
        oidc: Boolean(config.oidc),
        devLogin: true,
        error: "Display name must be 2 to 64 characters and cannot contain line breaks",
      }), 400);
    }
    const account = await db.upsertAccount(`dev:${username.toLowerCase()}`, username);
    return finishLogin(c, account.id, handoff);
  });

  app.get("/auth/oidc/start", async (c) => {
    if (!config.oidc) throw new HttpError(404, "SSO is not configured");
    const handoff = handoffFrom(c.req.query("return"), c.req.query("state"), c.req.query("device"), c.req.query("vault"));
    const request = await createOidcRequest(config.oidc);
    await db.saveOauthState(request.state, request.nonce, request.codeVerifier, handoff, Date.now() + 10 * 60 * 1000);
    return c.redirect(request.url);
  });

  app.get("/auth/oidc/callback", async (c) => {
    if (!config.oidc) throw new HttpError(404, "SSO is not configured");
    const oauthError = c.req.query("error");
    if (oauthError) return c.html(messagePage("Login failed", oauthError), 400);
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    const saved = await db.takeOauthState(state);
    if (!saved || !code) return c.html(messagePage("Login failed", "The login state expired. Start again."), 400);
    let identity: Awaited<ReturnType<typeof completeOidcLogin>>;
    try {
      identity = await completeOidcLogin(config.oidc, code, saved.codeVerifier, saved.nonce);
    } catch (error) {
      const message = error instanceof Error ? error.message : "SSO login failed";
      return c.html(messagePage("Login failed", message), 400);
    }
    const account = await db.upsertAccount(identity.subject, identity.displayName);
    return finishLogin(c, account.id, saved.deviceCode);
  });

  app.post("/auth/logout", (c) => {
    assertSameOrigin(c);
    c.header("Set-Cookie", clearCookieHeader(isSecure(c)));
    return c.redirect("/login");
  });

  app.post("/access", async (c) => {
    assertSameOrigin(c);
    const form = await c.req.parseBody();
    const token = String(form.token ?? "");
    if (!config.accessToken || !safeEqual(token, config.accessToken)) {
      return c.html(accessPage("Incorrect access token"), 401);
    }
    c.header("Set-Cookie", accessCookie(token, isSecure(c)));
    return c.redirect("/account");
  });

  app.get("/account/enter", async (c) => {
    const code = c.req.query("code") ?? "";
    if (!DEVICE_CODE.test(code)) return c.redirect("/login");
    const accountId = await db.takeLoginCode(code, "web");
    if (!accountId) return c.html(messagePage("Login expired", "Open the site from Obsidian again."), 400);
    c.header("Set-Cookie", setCookieHeader(sealSession(accountId, config.sessionSecret), isSecure(c)));
    const vault = c.req.query("vault") ?? "";
    const target = vault ? `/account?vault=${encodeURIComponent(vault)}` : "/account";
    return c.redirect(target);
  });

  app.get("/account", async (c) => {
    if (config.mode === "single") {
      if (!hasAccess(c)) return c.html(accessPage());
      const account = await db.ensureSingleAccount();
      return c.html(accountPage({
        displayName: account.displayName,
        accountId: account.id,
        vaults: await db.listVaultStats(account.id),
        recent: await db.listRecent(account.id, 20),
        notice: c.req.query("notice"),
        focusId: c.req.query("vault"),
        mode: "single",
      }));
    }
    const accountId = sessionAccount(c);
    if (!accountId) return c.redirect("/login");
    const account = await db.findAccount(accountId);
    if (!account) return c.redirect("/login");
    return c.html(accountPage({
      displayName: account.displayName,
      accountId: account.id,
      vaults: await db.listVaultStats(account.id),
      recent: await db.listRecent(account.id, 20),
      notice: c.req.query("notice"),
      focusId: c.req.query("vault"),
      mode: "central",
    }));
  });

  const api = new Hono();

  api.get("/health", (c) => c.json({
    ok: true,
    protocol: PROTOCOL_VERSION,
    mode: config.mode,
    storage: config.storage.kind,
    database: config.database.kind,
    requireEncryption: config.requireEncryption,
    oidc: Boolean(config.oidc),
    devLogin: config.allowDevLogin,
  }));

  api.get("/bootstrap", async (c) => {
    if (!hasAccess(c)) throw new HttpError(401, "Access token required");
    if (config.mode === "single") {
      const account = await db.ensureSingleAccount();
      const issue = c.req.query("issue") === "1";
      return c.json({
        mode: "single",
        accountId: account.id,
        displayName: account.displayName,
        apiToken: issue ? await db.issueToken(account.id) : undefined,
        requireEncryption: config.requireEncryption,
        registration: false,
      });
    }
    return c.json({
      mode: "central",
      accountId: null,
      requireEncryption: config.requireEncryption,
      registration: true,
    });
  });

  api.post("/device/start", async (c) => {
    const now = Date.now();
    deviceStarts = deviceStarts.filter((time) => now - time < 10 * 60 * 1000);
    if (deviceStarts.length >= 100) throw new HttpError(429, "Too many login attempts. Try again later.");
    deviceStarts.push(now);
    const deviceCode = bytesToBase64Url(randomBytes(32));
    const expiresAt = now + DEVICE_TTL_MS;
    await db.createDeviceCode(deviceCode, expiresAt);
    return c.json({ deviceCode, expiresAt });
  });

  api.get("/device/poll", async (c) => {
    const code = c.req.query("code") ?? "";
    if (!DEVICE_CODE.test(code)) throw new HttpError(404, "The login code is invalid or expired");
    const accountId = await db.takeDeviceAccount(code);
    if (accountId === undefined) throw new HttpError(404, "The login code is invalid or expired");
    if (accountId === null) return c.json({ status: "pending" }, 202);
    const apiToken = await db.issueToken(accountId);
    return c.json({ status: "ready", accountId, displayName: await accountName(accountId), apiToken });
  });

  api.post("/auth/exchange", async (c) => {
    const body = parseJson(await readBody(c, 8 * 1024)) as { code?: unknown; state?: unknown };
    const code = typeof body.code === "string" ? body.code : "";
    const state = typeof body.state === "string" ? body.state : "";
    if (!DEVICE_CODE.test(code) || !LOGIN_STATE.test(state)) throw new HttpError(400, "Invalid login callback");
    const accountId = await db.takeLoginCode(code, state);
    if (!accountId) throw new HttpError(400, "The login callback expired. Log in again from the plugin.");
    return c.json({ accountId, displayName: await accountName(accountId), apiToken: await db.issueToken(accountId) });
  });

  api.get("/account", async (c) => {
    const { accountId } = await requireToken(c);
    return c.json({ accountId, displayName: await accountName(accountId) });
  });

  api.post("/web-session", async (c) => {
    const { accountId } = await requireToken(c);
    const code = bytesToBase64Url(randomBytes(32));
    await db.createLoginCode(code, accountId, "web", Date.now() + 2 * 60 * 1000);
    return c.json({ code });
  });

  api.post("/logout", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (match?.[1]) await db.revokeToken(match[1]);
    return c.json({ ok: true });
  });

  api.get("/vaults", async (c) => {
    const { accountId } = await requireToken(c);
    const vaults = (await db.listVaultStats(accountId)).filter((vault) => vault.name);
    return c.json({ vaults });
  });

  api.post("/vaults", async (c) => {
    const { accountId } = await requireToken(c);
    const body = parseJson(await readBody(c)) as { name?: unknown; encrypted?: unknown; create?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!VAULT_NAME.test(name)) throw new HttpError(400, "Invalid vault name");
    const created = body.create === true
      ? await db.createVault(accountId, name, body.encrypted === true)
      : await db.rememberVault(accountId, name, body.encrypted === true);
    if (created === "duplicate") throw new HttpError(409, "A vault with this name already exists");
    const vault = (await db.listVaultStats(accountId)).find((item) => item.id === created);
    return c.json(vault ?? { id: created, name, files: 0, bytes: 0, lastSyncAt: 0, encrypted: body.encrypted === true });
  });

  api.delete("/vaults/:vaultId", async (c) => {
    const { accountId } = await requireToken(c);
    const vaultId = c.req.param("vaultId").trim();
    if (!/^[0-9a-f-]{36}$/i.test(vaultId)) throw new HttpError(400, "Invalid vault id");
    const removed = await db.deleteVault(accountId, vaultId);
    if (!removed) throw new HttpError(404, "The remote vault does not exist");
    for (const fileId of removed) await blobs.delete(accountId, fileId);
    return c.json({ ok: true, deleted: removed.length });
  });

  api.get("/manifest", async (c) => {
    const { accountId } = await requireToken(c);
    const key = (c.req.query("vault") ?? "").trim();
    const byId = await db.findVaultById(accountId, key);
    const name = byId?.name ?? (VAULT_NAME.test(key) ? key : "");
    if (!name) throw new HttpError(404, "The remote vault does not exist");
    const files = (await db.listObjects(accountId, name)).map((file) => ({
      fileId: file.fileId,
      contentMac: file.contentMac,
      size: file.size,
      mtime: file.mtime,
      updatedAt: file.updatedAt,
      encoding: file.encoding,
    }));
    return c.json({ files });
  });

  api.put("/objects/:fileId", async (c) => {
    const fileId = c.req.param("fileId");
    if (!FILE_ID.test(fileId)) throw new HttpError(400, "Invalid file ID");
    const raw = await readBody(c);
    const { accountId } = await requireToken(c);
    const payload = parseObjectPayload(parseJson(raw), config.requireEncryption);
    const named = payload.vaultId ? await db.findVaultById(accountId, payload.vaultId) : undefined;
    if (payload.vaultId && !named) throw new HttpError(404, "The remote vault does not exist");
    const vaultName = named?.name ?? payload.vault;
    if (payload.encoding !== "e2ee" && await db.vaultEncrypted(accountId, vaultName)) {
      throw new HttpError(409, "This vault is encrypted and no longer accepts plaintext");
    }
    await blobs.put(accountId, fileId, JSON.stringify(payload.contentCipher));
    await db.upsertObject({
      accountId,
      fileId,
      vaultName,
      pathCipher: JSON.stringify(payload.pathCipher),
      contentMac: payload.contentMac,
      size: payload.size,
      mtime: payload.mtime,
      updatedAt: Date.now(),
      encoding: payload.encoding,
    });
    await db.rememberVault(accountId, vaultName, payload.encoding === "e2ee");
    return c.json({ ok: true });
  });

  api.get("/objects/:fileId", async (c) => {
    const fileId = c.req.param("fileId");
    if (!FILE_ID.test(fileId)) throw new HttpError(400, "Invalid file ID");
    const { accountId } = await requireToken(c);
    const row = await db.findObject(accountId, fileId);
    if (!row) throw new HttpError(404, "This file is not on the server");
    const contentCipher = JSON.parse(await blobs.get(accountId, fileId)) as PayloadCipher;
    return c.json({
      vault: row.vaultName,
      pathCipher: JSON.parse(row.pathCipher) as PayloadCipher,
      contentCipher,
      contentMac: row.contentMac,
      size: row.size,
      mtime: row.mtime,
      encoding: row.encoding,
    });
  });

  api.post("/deletions", async (c) => {
    const raw = await readBody(c, 1024 * 1024);
    const { accountId } = await requireToken(c);
    const body = parseJson(raw) as { ids?: unknown; localCount?: unknown; vault?: unknown; clearUnnamed?: unknown };
    const vault = parseVaultName(typeof body.vault === "string" ? body.vault : undefined);
    if (!Array.isArray(body.ids) || body.ids.length > 10000 || body.ids.some((id) => typeof id !== "string" || !FILE_ID.test(id))) {
      throw new HttpError(400, "Invalid deletion list");
    }
    if (typeof body.localCount !== "number" || !Number.isInteger(body.localCount) || body.localCount < 0) {
      throw new HttpError(400, "Invalid local file count");
    }
    if (body.localCount === 0 && body.clearUnnamed === true) {
      throw new HttpError(409, "The local vault is empty, so the server backup was not cleared");
    }
    const removed = await db.deleteObjects(accountId, body.ids, vault);
    if (body.clearUnnamed === true && body.localCount > 0) {
      removed.push(...await db.deleteUnnamed(accountId));
    }
    for (const fileId of removed) await blobs.delete(accountId, fileId);
    return c.json({ deleted: removed.length });
  });

  app.route("/api/v1", api);

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "Unknown API" }, 404);
    return c.html(messagePage("Page not found", "This address does not exist"), 404);
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      if (c.req.path.startsWith("/api/") || (c.req.header("accept") ?? "").includes("application/json")) {
        return jsonMessage(err.status, err.message);
      }
      return c.html(messagePage("Something went wrong", err.message), errorStatus(err.status));
    }
    console.error(err);
    return jsonMessage(500, "Internal server error");
  });

  return app;

  function sessionAccount(c: Context): string | undefined {
    const token = readCookie(c.req.header("cookie"), sessionCookieName());
    if (!token) return undefined;
    return openSession(token, config.sessionSecret);
  }

  function hasAccess(c: Context): boolean {
    if (!config.accessToken) return true;
    const header = c.req.header("x-access-token") ?? "";
    const cookie = readCookie(c.req.header("cookie"), "sync_access") ?? "";
    return safeEqual(header, config.accessToken) || safeEqual(cookie, config.accessToken);
  }

  async function finishLogin(c: Context, accountId: string, handoff: string): Promise<Response> {
    c.header("Set-Cookie", setCookieHeader(sealSession(accountId, config.sessionSecret), isSecure(c)));
    const back = unpackObsidian(handoff);
    if (back) {
      const code = bytesToBase64Url(randomBytes(32));
      await db.createLoginCode(code, accountId, back.state, Date.now() + 2 * 60 * 1000);
      return c.html(obsidianReturnPage(code, back.state, back.vault));
    }
    let notice = "";
    if (handoff && DEVICE_CODE.test(handoff)) {
      notice = await db.claimDeviceCode(handoff, accountId) ? "device-ok" : "device-missing";
    }
    return c.redirect(notice ? `/account?notice=${notice}` : "/account");
  }

  async function accountName(accountId: string): Promise<string> {
    return (await db.findAccount(accountId))?.displayName ?? "";
  }

  async function requireToken(c: Context): Promise<{ accountId: string }> {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) throw new HttpError(401, "Log in from the plugin first");
    const accountId = await db.findAccountByToken(match[1] ?? "");
    if (!accountId) throw new HttpError(401, "The login expired. Log in again.");
    return { accountId };
  }
}

function safeDevice(value: string | undefined): string {
  return value && DEVICE_CODE.test(value) ? value : "";
}

function handoffFrom(returnTo: string | undefined, state: string | undefined, device: string | undefined, vault: string | undefined): string {
  if (returnTo === "obsidian" && state && LOGIN_STATE.test(state)) {
    const name = (vault ?? "").trim();
    const safeVault = name && VAULT_NAME.test(name) ? encodeURIComponent(name) : "";
    const packed = safeVault ? `obsidian:${state}:${safeVault}` : `obsidian:${state}`;
    return packed.length <= 128 ? packed : `obsidian:${state}`;
  }
  return safeDevice(device);
}

function unpackObsidian(handoff: string): { state: string; vault: string } | undefined {
  if (!handoff.startsWith("obsidian:")) return undefined;
  const rest = handoff.slice("obsidian:".length);
  const split = rest.indexOf(":");
  const state = split === -1 ? rest : rest.slice(0, split);
  const vault = split === -1 ? "" : decodeURIComponent(rest.slice(split + 1));
  if (!LOGIN_STATE.test(state)) return undefined;
  if (vault && !VAULT_NAME.test(vault)) return { state, vault: "" };
  return { state, vault };
}

function loginView(returnTo: string | undefined, state: string | undefined, device: string | undefined, vault: string | undefined): {
  device: string;
  returnTo?: string;
  state?: string;
  vault?: string;
} {
  const back = returnTo === "obsidian" && Boolean(state && LOGIN_STATE.test(state));
  const name = (vault ?? "").trim();
  return {
    device: safeDevice(device),
    returnTo: back ? "obsidian" : undefined,
    state: back ? state : undefined,
    vault: back && name && VAULT_NAME.test(name) ? name : undefined,
  };
}

function publicOrigin(c: Context): string {
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  if (!host) return new URL(c.req.url).origin;
  const proto = c.req.header("x-forwarded-proto") ?? (c.req.url.startsWith("https://") ? "https" : "http");
  return `${proto}://${host}`;
}

function iconResponse(_c: Context): Response {
  const dirs = [join(process.cwd(), "public"), join(process.cwd(), "server", "public")];
  for (const dir of dirs) {
    const path = join(dir, "favicon.png");
    if (!existsSync(path)) continue;
    const bytes = new Uint8Array(readFileSync(path));
    return new Response(bytes, {
      headers: {
        "content-type": "image/png",
        "cache-control": "no-cache",
      },
    });
  }
  throw new HttpError(404, "Icon not found");
}

const PLUGIN_FILES: Record<string, string> = {
  "manifest.json": "application/json; charset=utf-8",
  "main.js": "text/javascript; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
};

function pluginFile(c: Context, name: string): Response {
  const type = PLUGIN_FILES[name];
  if (!type) throw new HttpError(404, "Unknown file");
  const file = readPluginFile(name);
  if (!file) throw new HttpError(404, "Plugin files are not on the server");
  c.header("content-type", type);
  c.header("cache-control", "no-cache");
  return c.body(file);
}

function pluginVersion(): string {
  const raw = readPluginFile("manifest.json");
  if (!raw) return "";
  try {
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : "";
  } catch {
    return "";
  }
}

function pluginChecksums(): string | undefined {
  const lines: string[] = [];
  for (const name of Object.keys(PLUGIN_FILES)) {
    const file = readPluginFile(name);
    if (!file) return undefined;
    const hash = createHash("sha256").update(file).digest("hex");
    lines.push(`${hash}  ${name}`);
  }
  return `${lines.join("\n")}\n`;
}

function readPluginFile(name: string): string | undefined {
  const dirs = [process.env.PLUGIN_DIR, join(process.cwd(), "plugin"), join(process.cwd(), "..", "plugin")];
  for (const dir of dirs) {
    if (!dir) continue;
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    return readFileSync(path, "utf8");
  }
  return undefined;
}

function isSecure(c: Context): boolean {
  return c.req.url.startsWith("https://") || c.req.header("x-forwarded-proto") === "https";
}

function assertSameOrigin(c: Context): void {
  const host = c.req.header("host");
  if (!host) return;
  const origin = c.req.header("origin");
  if (origin && origin !== "null") {
    if (hostOf(origin) !== host) throw new HttpError(403, "Login origin does not match");
    return;
  }
  const referer = c.req.header("referer");
  if (referer && hostOf(referer) !== host) throw new HttpError(403, "Login origin does not match");
}

function hostOf(value: string): string | undefined {
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

async function readBody(c: Context, max = MAX_BODY_BYTES): Promise<Uint8Array> {
  const length = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(length) && length > max) throw new HttpError(413, "Request body is too large");
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > max) throw new HttpError(413, "Request body is too large");
  return body;
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function parseVaultName(value: string | undefined): string {
  const name = (value ?? "").trim();
  if (!VAULT_NAME.test(name)) throw new HttpError(400, "Invalid vault name");
  return name;
}

function parseCipher(value: unknown, requireEncryption: boolean): PayloadCipher {
  if (!value || typeof value !== "object") throw new HttpError(400, "Invalid ciphertext");
  const record = value as { v?: unknown; iv?: unknown; ct?: unknown; raw?: unknown };
  if (record.v === 0) {
    if (requireEncryption) throw new HttpError(400, "The server requires encryption and rejected plaintext");
    if (typeof record.raw !== "string" || record.raw.length > MAX_BODY_BYTES) {
      throw new HttpError(400, "Invalid plaintext");
    }
    return { v: 0, raw: record.raw };
  }
  if (record.v !== 1 || typeof record.iv !== "string" || typeof record.ct !== "string") {
    throw new HttpError(400, "Invalid ciphertext");
  }
  if (record.iv.length > 64 || record.ct.length > MAX_BODY_BYTES) throw new HttpError(413, "Ciphertext is too large");
  return { v: 1, iv: record.iv, ct: record.ct };
}

function parseObjectPayload(value: unknown, requireEncryption: boolean): ObjectPayload {
  if (!value || typeof value !== "object") throw new HttpError(400, "Invalid request");
  const body = value as Partial<ObjectPayload>;
  if (typeof body.contentMac !== "string" || !/^[0-9a-f]{64}$/.test(body.contentMac)) {
    throw new HttpError(400, "Invalid content fingerprint");
  }
  if (body.encoding !== "e2ee" && body.encoding !== "plain") throw new HttpError(400, "Invalid encryption flag");
  if (requireEncryption && body.encoding !== "e2ee") throw new HttpError(400, "The server requires encryption and rejected plaintext");
  if (typeof body.size !== "number" || !Number.isInteger(body.size) || body.size < 0 || body.size > MAX_FILE_BYTES) {
    throw new HttpError(400, "Invalid file size");
  }
  if (typeof body.mtime !== "number" || !Number.isFinite(body.mtime)) throw new HttpError(400, "Invalid modification time");
  const pathCipher = parseCipher(body.pathCipher, requireEncryption);
  const contentCipher = parseCipher(body.contentCipher, requireEncryption);
  const encoding: Encoding = body.encoding;
  if (cipherEncoding(pathCipher) !== encoding || cipherEncoding(contentCipher) !== encoding) {
    throw new HttpError(400, "Ciphertext format does not match the encryption flag");
  }
  return {
    vault: parseVaultName(typeof body.vault === "string" ? body.vault : undefined),
    vaultId: typeof body.vaultId === "string" ? body.vaultId : "",
    pathCipher,
    contentCipher,
    contentMac: body.contentMac,
    size: body.size,
    mtime: body.mtime,
    encoding,
  };
}

function cipherEncoding(value: PayloadCipher): Encoding {
  return value.v === 0 ? "plain" : "e2ee";
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function accessCookie(token: string, secure: boolean): string {
  const parts = [
    `sync_access=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=2592000",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function jsonMessage(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorStatus(status: number): 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 {
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 409 || status === 413 || status === 429) {
    return status;
  }
  return 500;
}
