import { openLocal, sealLocal, type LocalBox } from "./local-secret";
import { isDesktopApp, obsidianConfigDir, warnMissingObsidianConfig } from "./obsidian-dir";

export interface SharedSyncConfig {
  host: string;
  accountId: string;
  displayName: string;
  apiToken: string;
  secretKey: string;
  accessToken: string;
  encryptNotes: boolean;
}

const FILE = "e2ee-sync.json";

export type SharedWriteMode = "seed" | "replace";

export type SharedLoginKind = "unavailable" | "both-empty" | "logged-out" | "shared-empty" | "differs" | "matches";

export function vaultHasLogin(settings: { accountId?: string; apiToken?: string } | null | undefined): boolean {
  if (!settings) return false;
  return Boolean(settings.accountId?.trim() || settings.apiToken?.trim());
}

/**
 * Shared credentials are a first open convenience. A vault that already stored
 * a login field, including an empty one after logout, keeps that choice.
 */
export function shouldAdoptSharedLogin(input: {
  hasLogin: boolean;
  skipSharedLogin: boolean;
  storedHadLoginField: boolean;
}): boolean {
  return !input.hasLogin && !input.skipSharedLogin && !input.storedHadLoginField;
}

/**
 * How this vault's login relates to the desktop file.
 * `logged-out` is an empty vault with a shared login waiting (including after logout).
 */
export function sharedLoginKind(
  vault: Pick<SharedSyncConfig, "accountId" | "apiToken" | "secretKey" | "accessToken">,
  shared: Partial<SharedSyncConfig> | null,
  available: boolean,
): SharedLoginKind {
  if (!available) return "unavailable";
  const vaultLogin = vaultHasLogin(vault);
  const sharedLogin = vaultHasLogin(shared);
  if (!vaultLogin && !sharedLogin) return "both-empty";
  if (!vaultLogin && sharedLogin) return "logged-out";
  if (vaultLogin && !sharedLogin) return "shared-empty";
  const same = vault.accountId === (shared?.accountId ?? "")
    && vault.apiToken === (shared?.apiToken ?? "")
    && vault.secretKey === (shared?.secretKey ?? "")
    && vault.accessToken === (shared?.accessToken ?? "");
  return same ? "matches" : "differs";
}

export function sharedConfigProblem(): boolean {
  return isDesktopApp() && !obsidianConfigDir();
}

export function readSharedConfig(): { config: Partial<SharedSyncConfig> | null; hadPlaintext: boolean } {
  if (!isDesktopApp()) return { config: null, hadPlaintext: false };
  const dir = obsidianConfigDir();
  if (!dir) {
    warnMissingObsidianConfig();
    return { config: null, hadPlaintext: false };
  }
  try {
    const parsed = JSON.parse(node().readText(node().join(dir, FILE))) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return { config: null, hadPlaintext: false };
    const hadPlaintext = typeof parsed.apiToken === "string" || typeof parsed.secretKey === "string";
    const config: Partial<SharedSyncConfig> = {};
    if (typeof parsed.host === "string") config.host = parsed.host;
    if (typeof parsed.accountId === "string") config.accountId = parsed.accountId;
    if (typeof parsed.displayName === "string") config.displayName = parsed.displayName;
    if (typeof parsed.accessToken === "string") config.accessToken = parsed.accessToken;
    const apiToken = openLocal(parsed.apiTokenBox) || (typeof parsed.apiToken === "string" ? parsed.apiToken : "");
    const secretKey = openLocal(parsed.secretKeyBox) || (typeof parsed.secretKey === "string" ? parsed.secretKey : "");
    if (apiToken) config.apiToken = apiToken;
    if (secretKey) config.secretKey = secretKey;
    return { config, hadPlaintext };
  } catch {
    return { config: null, hadPlaintext: false };
  }
}

/**
 * `seed` writes the first login, including its host, into an empty shared file.
 * It never replaces a login that is already there, and a logged-out vault does
 * not wipe the file. `replace` is the explicit "copy this vault's login" action.
 * Returns null when the file should be left untouched.
 */
export function mergeSharedConfig(
  existing: Partial<SharedSyncConfig> | null,
  incoming: SharedSyncConfig,
  mode: SharedWriteMode,
): SharedSyncConfig | null {
  if (mode === "replace") {
    if (!vaultHasLogin(incoming)) return null;
    const next = copyShared(incoming);
    if (!next.host.trim() && existing?.host?.trim()) next.host = existing.host;
    return next;
  }
  const next = copyShared(existing ?? {});
  if (vaultHasLogin(next) || !vaultHasLogin(incoming)) return null;
  if (!next.host.trim() && incoming.host.trim()) next.host = incoming.host;
  next.accountId = incoming.accountId;
  next.displayName = incoming.displayName;
  next.apiToken = incoming.apiToken;
  next.secretKey = incoming.secretKey;
  next.accessToken = incoming.accessToken;
  return next;
}

export function writeSharedConfig(config: SharedSyncConfig, mode: SharedWriteMode = "seed"): boolean {
  if (!isDesktopApp()) return false;
  const dir = obsidianConfigDir();
  if (!dir) {
    warnMissingObsidianConfig();
    return false;
  }
  const existing = readSharedConfig();
  let next = mergeSharedConfig(existing.config, config, mode);
  if (!next) {
    if (!(mode === "seed" && existing.hadPlaintext && existing.config && vaultHasLogin(existing.config))) return false;
    next = copyShared(existing.config);
  }
  const body = {
    host: next.host,
    accountId: next.accountId,
    displayName: next.displayName,
    accessToken: next.accessToken,
    apiTokenBox: sealLocal(next.apiToken) satisfies LocalBox,
    secretKeyBox: sealLocal(next.secretKey) satisfies LocalBox,
  };
  try {
    const fs = node();
    const path = fs.join(dir, FILE);
    fs.mkdirSync(fs.dirname(path), { recursive: true });
    fs.writeText(path, JSON.stringify(body, null, 2));
    return true;
  } catch (error) {
    console.warn("Could not write the config shared across vaults", error);
    return false;
  }
}

/**
 * Credentials and host are copied only when `applyLogin` is set.
 * The default is a vault that has no login yet. A vault that already has a
 * login keeps its host and credentials, including an empty host or secret.
 * An empty host means the default server, so it is not a blank to fill in.
 */
export function applySharedConfig<T extends SharedSyncConfig>(
  settings: T,
  shared: Partial<SharedSyncConfig> | null,
  options?: { applyLogin?: boolean },
): T {
  if (!shared) return settings;
  const applyLogin = options?.applyLogin ?? !vaultHasLogin(settings);
  if (!applyLogin || !vaultHasLogin(shared)) return settings;
  if (!settings.host.trim() && typeof shared.host === "string" && shared.host.trim()) {
    settings.host = shared.host;
  }
  if (typeof shared.accountId === "string") settings.accountId = shared.accountId;
  if (typeof shared.displayName === "string") settings.displayName = shared.displayName;
  if (typeof shared.apiToken === "string") settings.apiToken = shared.apiToken;
  if (typeof shared.secretKey === "string") settings.secretKey = shared.secretKey;
  if (typeof shared.accessToken === "string") settings.accessToken = shared.accessToken;
  return settings;
}

function copyShared(config: Partial<SharedSyncConfig>): SharedSyncConfig {
  return {
    host: typeof config.host === "string" ? config.host : "",
    accountId: typeof config.accountId === "string" ? config.accountId : "",
    displayName: typeof config.displayName === "string" ? config.displayName : "",
    apiToken: typeof config.apiToken === "string" ? config.apiToken : "",
    secretKey: typeof config.secretKey === "string" ? config.secretKey : "",
    accessToken: typeof config.accessToken === "string" ? config.accessToken : "",
    encryptNotes: false,
  };
}

interface NodeApi {
  dirname: (path: string) => string;
  join: (...paths: string[]) => string;
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  readText: (path: string) => string;
  writeText: (path: string, data: string) => void;
}

function node(): NodeApi {
  const fs = require("fs") as {
    mkdirSync: NodeApi["mkdirSync"];
    readFileSync: (path: string, encoding: "utf8") => string;
    writeFileSync: (path: string, data: string) => void;
  };
  const path = require("path") as { dirname: NodeApi["dirname"]; join: NodeApi["join"] };
  return {
    dirname: (target) => path.dirname(target),
    join: (...parts) => path.join(...parts),
    mkdirSync: (target, options) => fs.mkdirSync(target, options),
    readText: (target) => fs.readFileSync(target, "utf8"),
    writeText: (target, data) => fs.writeFileSync(target, data),
  };
}

declare function require(moduleName: string): unknown;
