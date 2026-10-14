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

export function writeSharedConfig(config: SharedSyncConfig): void {
  if (!isDesktopApp()) return;
  const dir = obsidianConfigDir();
  if (!dir) {
    warnMissingObsidianConfig();
    return;
  }
  const empty = !config.accountId && !config.apiToken && !config.secretKey;
  if (empty) {
    const existing = readSharedConfig();
    if (!existing.config?.accountId && !existing.config?.apiToken && !existing.config?.secretKey) return;
  }
  const body = {
    host: config.host,
    accountId: config.accountId,
    displayName: config.displayName,
    accessToken: config.accessToken,
    apiTokenBox: sealLocal(config.apiToken) satisfies LocalBox,
    secretKeyBox: sealLocal(config.secretKey) satisfies LocalBox,
  };
  try {
    const fs = node();
    const path = fs.join(dir, FILE);
    fs.mkdirSync(fs.dirname(path), { recursive: true });
    fs.writeText(path, JSON.stringify(body, null, 2));
  } catch (error) {
    console.warn("Could not write the config shared across vaults", error);
  }
}

export function applySharedConfig<T extends SharedSyncConfig>(settings: T, shared: Partial<SharedSyncConfig> | null): T {
  if (!shared) return settings;
  if (typeof shared.host === "string") settings.host = shared.host;
  if (typeof shared.accountId === "string") settings.accountId = shared.accountId;
  if (typeof shared.displayName === "string") settings.displayName = shared.displayName;
  if (typeof shared.apiToken === "string") settings.apiToken = shared.apiToken;
  if (typeof shared.secretKey === "string") settings.secretKey = shared.secretKey;
  if (typeof shared.accessToken === "string") settings.accessToken = shared.accessToken;
  return settings;
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
