import { requestUrl, type RequestUrlResponse } from "obsidian";
import {
  normalizeHost,
  remoteRev,
  type ChangesResponse,
  type ConflictBody,
  type DownloadUrl,
  type Manifest,
  type ObjectPayload,
  type PayloadCipher,
  type PutResult,
  type RemoteFile,
  type UrlListResponse,
  type VaultStat,
} from "../../shared/src/protocol";

export function resolveSyncHost(input: string): string {
  return normalizeHost(input);
}

export interface ServerHealth {
  ok: boolean;
  mode: "central" | "single";
  storage: "file" | "database" | "qiniu" | "r2";
  database: "sqlite" | "postgres" | "mysql";
  requireEncryption: boolean;
  oidc: boolean;
  devLogin: boolean;
}

export interface Bootstrap {
  mode: "central" | "single";
  accountId: string | null;
  displayName?: string;
  apiToken?: string;
  requireEncryption: boolean;
  registration: boolean;
}

export async function fetchHealth(host: string): Promise<ServerHealth> {
  return publicJson(host, "GET", "/api/v1/health");
}

export async function fetchBootstrap(host: string, accessToken: string, issue = false): Promise<Bootstrap> {
  const path = issue ? "/api/v1/bootstrap?issue=1" : "/api/v1/bootstrap";
  return publicJson(host, "GET", path, undefined, accessToken);
}

export async function exchangeLogin(host: string, code: string, state: string): Promise<{ accountId: string; apiToken: string; displayName?: string }> {
  return publicJson(host, "POST", "/api/v1/auth/exchange", { code, state });
}

export async function startDeviceLogin(host: string): Promise<{ deviceCode: string; expiresAt: number }> {
  return publicJson(host, "POST", "/api/v1/device/start");
}

export async function pollDevice(host: string, code: string): Promise<{ pending: boolean; accountId?: string; displayName?: string; apiToken?: string }> {
  const response = await send("GET", `${host}/api/v1/device/poll?code=${encodeURIComponent(code)}`);
  if (response.status === 202) return { pending: true };
  if (response.status === 200) {
    return {
      pending: false,
      accountId: String(response.json.accountId ?? ""),
      displayName: String(response.json.displayName ?? ""),
      apiToken: String(response.json.apiToken ?? ""),
    };
  }
  throw new Error(errorMessage(response));
}

export class SyncClient {
  constructor(
    private readonly host: string,
    private readonly token: string,
    private readonly onRetry?: (seconds: number) => void,
  ) {}

  vaults(): Promise<{ vaults: VaultStat[] }> {
    return this.authed("GET", "/api/v1/vaults");
  }

  profile(): Promise<{ accountId: string; displayName: string }> {
    return this.authed("GET", "/api/v1/account");
  }

  manifest(vault: string): Promise<Manifest> {
    return this.authed("GET", `/api/v1/manifest?vault=${encodeURIComponent(vault)}`);
  }

  changes(vault: string, since: number): Promise<ChangesResponse> {
    const query = new URLSearchParams({ vault, since: String(since) });
    return this.authed("GET", `/api/v1/changes?${query.toString()}`);
  }

  async putObject(fileId: string, payload: ObjectPayload): Promise<PutResult> {
    const content = JSON.stringify(payload.contentCipher);
    const bytes = new TextEncoder().encode(content).byteLength;
    const parentRev = payload.parentRev ?? null;
    const listed = await this.urlList(payload.vaultId || payload.vault, {
      uploads: [{ fileId, parentRev, bytes }],
    });
    const conflict = listed.conflicts.find((item) => item.fileId === fileId);
    if (conflict) throw new SyncConflictError(conflict.reason, conflictFile(conflict.file));
    const upload = listed.uploads.find((item) => item.fileId === fileId);
    if (!upload) throw new Error("The server did not return an upload URL");
    const sent = await transfer("PUT", upload.url, content);
    if (sent.status >= 400) throw new Error(errorMessage(sent));
    const response = await send("POST", `${this.host}/api/v1/objects/${fileId}/commit`, {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json; charset=utf-8",
    }, JSON.stringify({
      vault: payload.vault,
      vaultId: payload.vaultId,
      pathCipher: payload.pathCipher,
      contentMac: payload.contentMac,
      size: payload.size,
      mtime: payload.mtime,
      encoding: payload.encoding,
      parentRev,
      parent_rev: parentRev,
      blobBytes: bytes,
    }), this.onRetry);
    const body = response.json as Partial<ConflictBody & PutResult> | null;
    if (response.status === 409 && body && (body.reason === "parent_rev" || body.reason === "deleted")) {
      throw new SyncConflictError(body.reason, conflictFile(body.file));
    }
    if (response.status >= 400) throw new Error(errorMessage(response));
    return {
      ok: true,
      rev: typeof body?.rev === "number" ? body.rev : 0,
      contentMac: typeof body?.contentMac === "string" ? body.contentMac : payload.contentMac,
      mtime: typeof body?.mtime === "number" ? body.mtime : payload.mtime,
      encoding: body?.encoding === "plain" || body?.encoding === "e2ee" ? body.encoding : payload.encoding,
      size: typeof body?.size === "number" ? body.size : payload.size,
      updatedAt: typeof body?.updatedAt === "number" ? body.updatedAt : Date.now(),
    };
  }

  async getObject(fileId: string, vaultId: string): Promise<ObjectPayload> {
    const listed = await this.urlList(vaultId, { downloads: [fileId] });
    if (listed.missing.includes(fileId)) throw new Error("This file is not on the server");
    const item = listed.downloads.find((entry) => entry.fileId === fileId);
    if (!item) throw new Error("This file is not on the server");
    return this.readObject(item);
  }

  urlList(vault: string, query: { downloads?: string[]; uploads?: { fileId: string; parentRev?: number | null; bytes: number }[] }): Promise<UrlListResponse> {
    return this.authed<UrlListResponse>("POST", "/api/v1/urls", {
      vault,
      downloads: query.downloads ?? [],
      uploads: query.uploads ?? [],
    }).then(normalizeUrlList);
  }

  async readObject(item: DownloadUrl): Promise<ObjectPayload> {
    const contentCipher = await this.fetchCipher(item.url);
    return {
      vault: "",
      pathCipher: item.pathCipher,
      contentCipher,
      contentMac: item.contentMac,
      size: item.size,
      mtime: item.mtime,
      encoding: item.encoding,
    };
  }

  async fetchCipher(url: string): Promise<PayloadCipher> {
    const response = await transfer("GET", url);
    if (response.status === 404) throw new Error("This file is not on the server");
    if (response.status >= 400) throw new Error(errorMessage(response));
    try {
      const parsed = JSON.parse(response.text) as PayloadCipher;
      if (!parsed || (parsed.v !== 0 && parsed.v !== 1)) throw new Error("invalid");
      return parsed;
    } catch {
      throw new Error("The downloaded file was not valid ciphertext");
    }
  }

  deleteObjects(vault: string, ids: string[], localCount: number, clearUnnamed = false): Promise<{ deleted: number }> {
    return this.authed("POST", "/api/v1/deletions", { vault, ids, localCount, clearUnnamed });
  }

  deleteVault(vaultId: string): Promise<{ ok: boolean; deleted: number }> {
    return this.authed("DELETE", `/api/v1/vaults/${encodeURIComponent(vaultId)}`);
  }

  webSession(): Promise<{ code: string }> {
    return this.authed("POST", "/api/v1/web-session");
  }

  async ensureVault(name: string, encrypted = false, create = false): Promise<VaultStat> {
    const bodyText = JSON.stringify({ name, encrypted, create });
    const response = await send("POST", `${this.host}/api/v1/vaults`, {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json; charset=utf-8",
    }, bodyText, this.onRetry);
    if (response.status === 409) throw new DuplicateVaultError();
    if (response.status >= 400) throw new Error(errorMessage(response));
    return response.json as VaultStat;
  }

  logout(): Promise<{ ok: boolean }> {
    return this.authed("POST", "/api/v1/logout");
  }

  private async authed<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const bodyText = payload === undefined ? "" : JSON.stringify(payload);
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (bodyText) headers["content-type"] = "application/json; charset=utf-8";
    const response = await send(method, this.host + path, headers, bodyText || undefined, this.onRetry);
    if (response.status >= 400) throw new Error(errorMessage(response));
    return response.json as T;
  }
}

async function publicJson<T>(host: string, method: string, path: string, payload?: unknown, accessToken = ""): Promise<T> {
  const headers: Record<string, string> = {};
  if (payload !== undefined) headers["content-type"] = "application/json; charset=utf-8";
  if (accessToken) headers["x-access-token"] = accessToken;
  const response = await send(
    method,
    host + path,
    Object.keys(headers).length ? headers : undefined,
    payload === undefined ? undefined : JSON.stringify(payload),
  );
  if (response.status >= 400) throw new Error(errorMessage(response));
  return response.json as T;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Request timed out")), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function normalizeUrlList(value: UrlListResponse): UrlListResponse {
  return {
    downloads: Array.isArray(value?.downloads) ? value.downloads : [],
    uploads: Array.isArray(value?.uploads) ? value.uploads : [],
    conflicts: Array.isArray(value?.conflicts) ? value.conflicts : [],
    missing: Array.isArray(value?.missing) ? value.missing : [],
  };
}

async function transfer(method: "GET" | "PUT", url: string, body?: string): Promise<RequestUrlResponse> {
  return send(method, url, body === undefined ? undefined : { "content-type": "application/json; charset=utf-8" }, body, undefined, 120_000);
}

async function send(
  method: string,
  url: string,
  headers?: Record<string, string>,
  body?: string,
  onRetry?: (seconds: number) => void,
  timeoutMs = 0,
): Promise<RequestUrlResponse> {
  const path = new URL(url).pathname;
  const retryable = method === "GET" || method === "PUT";
  const attempts = retryable ? 3 : 1;
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const ms = timeoutMs || (path.startsWith("/api/v1/objects/") ? 120_000 : 30_000);
      const response = await withTimeout(requestUrl({
        url,
        method,
        headers,
        body,
        throw: false,
      }), ms);
      if (response.status >= 500 && retryable && attempt < attempts - 1) {
        throw new Error(errorMessage(response));
      }
      return response;
    } catch (error) {
      last = error;
      if (!retryable || attempt === attempts - 1) break;
      const seconds = 2 ** (attempt + 1);
      onRetry?.(seconds);
      await delay(seconds * 1000);
    }
  }
  throw last instanceof Error ? last : new Error("Request failed");
}

export class SyncConflictError extends Error {
  readonly status = 409;

  constructor(
    readonly reason: ConflictBody["reason"],
    readonly file: RemoteFile | null,
  ) {
    super(reason === "deleted"
      ? "The remote copy was deleted since this device last synced"
      : "The remote copy changed since this device last synced");
    this.name = "SyncConflictError";
  }
}

function conflictFile(value: RemoteFile | null | undefined): RemoteFile | null {
  if (!value || typeof value !== "object") return null;
  if (typeof value.fileId !== "string" || typeof value.contentMac !== "string") return null;
  return { ...value, rev: remoteRev(value) };
}

export class DuplicateVaultError extends Error {
  constructor() {
    super("duplicate-vault");
    this.name = "DuplicateVaultError";
  }
}

function errorMessage(response: RequestUrlResponse): string {
  const body = response.json as { error?: unknown } | null;
  if (body && typeof body.error === "string" && body.error) return body.error;
  const text = response.text?.trim();
  return text || `Request failed (${response.status})`;
}

declare function require(moduleName: string): {
  shell?: { openExternal?: (target: string) => void };
};

export function openExternal(url: string): void {
  try {
    const open = require("electron").shell?.openExternal;
    if (open) {
      open(url);
      return;
    }
  } catch {
    // Mobile has no electron. Open the page in the browser instead.
  }
  window.open(url);
}
