import { requestUrl, type RequestUrlResponse } from "obsidian";
import { normalizeHost, type Manifest, type ObjectPayload, type VaultStat } from "../../shared/src/protocol";

export function resolveSyncHost(input: string): string {
  return normalizeHost(input);
}

export interface ServerHealth {
  ok: boolean;
  mode: "central" | "single";
  storage: "file" | "database" | "qiniu";
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

  putObject(fileId: string, payload: ObjectPayload): Promise<void> {
    return this.authed("PUT", `/api/v1/objects/${fileId}`, payload);
  }

  getObject(fileId: string): Promise<ObjectPayload> {
    return this.authed("GET", `/api/v1/objects/${fileId}`);
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

async function send(
  method: string,
  url: string,
  headers?: Record<string, string>,
  body?: string,
  onRetry?: (seconds: number) => void,
): Promise<RequestUrlResponse> {
  const path = new URL(url).pathname;
  const retryable = method === "GET" || method === "PUT";
  const attempts = retryable ? 3 : 1;
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const ms = path.startsWith("/api/v1/objects/") ? 120_000 : 30_000;
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
