import { FileSystemAdapter, Modal, Notice, TFile, type App, type Vault } from "obsidian";
import { bytesToBase64, randomBytes } from "../../shared/src/codec";
import { contentMac, deriveKeys, fileIdForPath, openBytes, plainFileId, plainMac, sealBytes } from "../../shared/src/crypto";
import { MAX_FILE_BYTES, MIN_SECRET_LENGTH, type Encoding, type VaultStat } from "../../shared/src/protocol";
import { SyncClient, fetchBootstrap, openExternal, resolveSyncHost } from "./client";
import { t } from "./i18n";
import { isDesktopApp, obsidianConfigDir, warnMissingObsidianConfig } from "./obsidian-dir";
import type E2eeSyncPlugin from "./main";

export type RestoreMode = "overwrite" | "create";

const BLOCKED = new Set([".obsidian", ".git", ".trash", "node_modules"]);
const PLUGIN_FILES = new Set([
  ".obsidian/plugins/e2ee-sync/manifest.json",
  ".obsidian/plugins/e2ee-sync/main.js",
  ".obsidian/plugins/e2ee-sync/styles.css",
]);

export function isSyncablePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (PLUGIN_FILES.has(normalized)) return true;
  return normalized.split("/").every((part) => part && !BLOCKED.has(part));
}

export function propagatePlugin(plugin: E2eeSyncPlugin): string[] {
  if (!isDesktopApp()) return [];
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return [];
  const fs = nodeFs();
  const source = fs.resolve(adapter.getBasePath(), ".obsidian", "plugins", "e2ee-sync");
  if (!fs.existsSync(fs.resolve(source, "main.js"))) return [];
  const configDir = obsidianConfigDir();
  if (!configDir) {
    warnMissingObsidianConfig();
    return [];
  }
  let parsed: { vaults?: Record<string, { path?: string }> } = {};
  try {
    parsed = JSON.parse(fs.readText(fs.resolve(configDir, "obsidian.json"))) as typeof parsed;
  } catch (error) {
    console.warn("Could not read the Obsidian vault list", error);
    return [];
  }
  const current = fs.resolve(adapter.getBasePath());
  const installed: string[] = [];
  for (const vault of Object.values(parsed.vaults ?? {})) {
    if (!vault.path) continue;
    const dest = fs.resolve(vault.path);
    if (dest === current || !fs.existsSync(dest)) continue;
    const marker = fs.resolve(dest, ".obsidian", "plugins", "e2ee-sync", "main.js");
    const fresh = !fs.existsSync(marker);
    const sourceMtime = fs.statMtime(fs.resolve(source, "main.js"));
    if (fresh || sourceMtime > fs.statMtime(marker)) installPluginCopy(plugin, dest);
    else enablePlugin(fs, dest);
    if (fresh) installed.push(vault.path);
  }
  return installed;
}

export async function pushVault(plugin: E2eeSyncPlugin): Promise<string> {
  const ready = await openClient(plugin);
  const encoding: Encoding = plugin.settings.encryptNotes ? "e2ee" : "plain";
  if (encoding === "plain") {
    const boot = await fetchBootstrap(ready.host, plugin.settings.accessToken);
    if (boot.requireEncryption) throw new Error(t("serverEncrypt"));
  }
  const files = plugin.app.vault.getFiles().filter((file) => isSyncablePath(file.path));
  const manifest = await ready.client.manifest(ready.vaultName);
  const remote = new Map(manifest.files.map((file) => [file.fileId, file]));
  const seen = new Set<string>();
  const index = { ...plugin.settings.index };
  let uploaded = 0;
  let unchanged = 0;
  const skippedLarge: string[] = [];
  const now = Date.now();

  for (const file of files) {
    const fileId = ready.keys
      ? await fileIdForPath(ready.keys.idKey, file.path, ready.vaultName)
      : await plainFileId(ready.vaultName, file.path);
    seen.add(fileId);
    if (file.stat.size > MAX_FILE_BYTES) {
      skippedLarge.push(file.path);
      continue;
    }
    const cached = index[fileId];
    const remoteFile = remote.get(fileId);
    if (
      cached
      && cached.mtime === file.stat.mtime
      && cached.size === file.stat.size
      && remoteFile?.contentMac === cached.contentMac
      && remoteFile.encoding === encoding
      && cached.encoding === encoding
    ) {
      index[fileId] = { ...cached, path: file.path, syncedAt: cached.syncedAt ?? now };
      unchanged++;
      continue;
    }
    const plain = new Uint8Array(await plugin.app.vault.readBinary(file));
    const mac = ready.keys ? await contentMac(ready.keys.idKey, plain) : await plainMac(plain);
    if (remoteFile?.contentMac === mac && remoteFile.encoding === encoding) {
      index[fileId] = { path: file.path, mtime: file.stat.mtime, size: file.stat.size, contentMac: mac, encoding, syncedAt: cached?.syncedAt ?? now };
      unchanged++;
      continue;
    }
    await ready.client.putObject(fileId, {
      vault: ready.vaultName,
      pathCipher: ready.keys
        ? await sealBytes(ready.keys.encKey, new TextEncoder().encode(file.path), `path:${fileId}`, true)
        : { v: 0, raw: bytesToBase64(new TextEncoder().encode(file.path)) },
      contentCipher: ready.keys
        ? await sealBytes(ready.keys.encKey, plain, `body:${fileId}`, true)
        : { v: 0, raw: bytesToBase64(plain) },
      contentMac: mac,
      size: plain.byteLength,
      mtime: file.stat.mtime,
      encoding,
    });
    index[fileId] = { path: file.path, mtime: file.stat.mtime, size: file.stat.size, contentMac: mac, encoding, syncedAt: Date.now() };
    uploaded++;
    plugin.setStatus(t("syncProgress", { done: uploaded + unchanged, total: files.length }));
  }

  const deleteIds = [...remote.keys()].filter((fileId) => !seen.has(fileId));
  const result = await ready.client.deleteObjects(ready.vaultName, deleteIds, files.length, files.length > 0);
  const deleted = result.deleted;
  for (const fileId of Object.keys(index)) {
    if (!seen.has(fileId)) delete index[fileId];
  }

  plugin.settings.index = index;
  plugin.settings.lastSyncAt = Date.now();
  const large = skippedLarge.length ? t("large", { n: skippedLarge.length }) : "";
  plugin.settings.lastSyncSummary = t("summary", {
    vault: ready.vaultName,
    uploaded,
    unchanged,
    deleted,
    large,
  });
  await plugin.saveSettings();
  return plugin.settings.lastSyncSummary;
}

export async function restoreVault(plugin: E2eeSyncPlugin, vaultName: string, mode: RestoreMode, localName = ""): Promise<string> {
  const token = plugin.settings.apiToken.trim();
  if (!token) throw new Error(t("needLogin"));
  const host = resolveSyncHost(plugin.settings.host);
  const client = new SyncClient(host, token, (seconds) => plugin.setStatus(t("retrying", { n: seconds })));
  const manifest = await client.manifest(vaultName);
  const needsKey = manifest.files.some((file) => file.encoding === "e2ee");
  if (needsKey && plugin.settings.secretKey.trim().length < MIN_SECRET_LENGTH) throw new Error(t("needSecret"));
  const keys = needsKey ? await deriveKeys(requireSecret(plugin.settings.secretKey)) : null;
  const destination = mode === "create" ? createVaultDirectory(plugin, localName.trim() || vaultName) : "";
  const written: Array<{ path: string; fileId: string; contentMac: string; encoding: Encoding }> = [];
  let restored = 0;
  for (const file of manifest.files) {
    const stored = await client.getObject(file.fileId);
    const path = safeVaultPath(new TextDecoder().decode(
      await openBytes(keys?.encKey ?? null, stored.pathCipher, `path:${file.fileId}`),
    ));
    const data = await openBytes(keys?.encKey ?? null, stored.contentCipher, `body:${file.fileId}`);
    if (mode === "create") writeOutside(destination, path, data);
    else await writeVaultFile(plugin.app.vault, path, data);
    written.push({ path, fileId: file.fileId, contentMac: file.contentMac, encoding: file.encoding });
    restored++;
    plugin.setStatus(t("restoreProgress", { done: restored, total: manifest.files.length }));
  }
  if (mode === "overwrite") {
    plugin.settings.boundVault = vaultName;
    plugin.settings.boundAccountId = plugin.settings.accountId;
    plugin.settings.encryptNotes = needsKey;
    const index = { ...plugin.settings.index };
    const syncedAt = Date.now();
    for (const item of written) {
      const local = plugin.app.vault.getAbstractFileByPath(item.path);
      if (!(local instanceof TFile)) continue;
      index[item.fileId] = {
        path: item.path,
        mtime: local.stat.mtime,
        size: local.stat.size,
        contentMac: item.contentMac,
        encoding: item.encoding,
        syncedAt,
      };
    }
    plugin.settings.index = index;
  }
  if (mode === "create") {
    installPluginCopy(plugin, destination);
    writeBoundSettings(destination, vaultName, needsKey, plugin.settings.accountId);
    registerVault(destination);
    openExternal(`obsidian://open?path=${encodeURIComponent(destination)}`);
  }
  plugin.settings.lastSyncSummary = mode === "create"
    ? t("openedVault", { vault: vaultName, path: destination, count: restored })
    : t("overwritten", { vault: vaultName, count: restored });
  await plugin.saveSettings();
  return plugin.settings.lastSyncSummary;
}

export class RestoreModal extends Modal {
  private selected = "";
  private nameInput: HTMLInputElement | null = null;

  constructor(app: App, private readonly plugin: E2eeSyncPlugin) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("restoreTitle"));
    this.contentEl.setText(t("loadingVaults"));
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const ready = await openClient(this.plugin);
      const listed = await ready.client.vaults();
      this.render(listed.vaults);
    } catch (error) {
      this.contentEl.empty();
      this.contentEl.createEl("p", { text: error instanceof Error ? error.message : t("readFailed") });
    }
  }

  private render(vaults: VaultStat[]): void {
    this.contentEl.empty();
    if (vaults.length === 0) {
      this.contentEl.createEl("p", { text: t("noBackups") });
      return;
    }
    this.selected = vaults[0]?.name ?? "";
    this.contentEl.createEl("p", { text: t("restoreHelp") });
    const nameRow = this.contentEl.createDiv({ cls: "e2ee-sync-name" });
    nameRow.createEl("div", { text: t("newVaultName") });
    this.nameInput = nameRow.createEl("input", { type: "text" });
    this.nameInput.value = this.selected;
    const list = this.contentEl.createDiv({ cls: "e2ee-sync-vaults" });
    const rows: HTMLElement[] = [];
    for (const vault of vaults) {
      const row = list.createDiv({ cls: "e2ee-sync-vault" });
      row.createEl("div", { text: vault.name });
      row.createEl("div", {
        text: t("vaultMeta", { files: vault.files, bytes: formatBytes(vault.bytes), time: formatStamp(vault.lastSyncAt) }),
        cls: "e2ee-sync-status-line",
      });
      row.onclick = () => {
        const previous = this.selected;
        this.selected = vault.name;
        if (this.nameInput && (this.nameInput.value.trim() === "" || this.nameInput.value.trim() === previous)) {
          this.nameInput.value = vault.name;
        }
        for (const item of rows) item.toggleClass("is-selected", item === row);
      };
      rows.push(row);
    }
    rows[0]?.addClass("is-selected");
    const actions = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
    const overwrite = actions.createEl("button", { text: t("overwrite"), cls: "mod-warning" });
    overwrite.onclick = () => this.choose("overwrite");
    const create = actions.createEl("button", { text: t("createVault") });
    create.onclick = () => this.choose("create");
    const cancel = actions.createEl("button", { text: t("cancel") });
    cancel.onclick = () => this.close();
  }

  private choose(mode: RestoreMode): void {
    const vaultName = this.selected;
    const localName = this.nameInput?.value.trim() || vaultName;
    if (!vaultName) return;
    this.close();
    void this.plugin.restoreNow(vaultName, mode, localName);
  }
}

export function notifyResult(manual: boolean, summary: string): void {
  if (manual) new Notice(summary);
}

async function openClient(plugin: E2eeSyncPlugin): Promise<{
  host: string;
  client: SyncClient;
  keys: Awaited<ReturnType<typeof deriveKeys>> | null;
  vaultName: string;
}> {
  const token = plugin.settings.apiToken.trim();
  if (!token) throw new Error(t("needLogin"));
  const vaultName = plugin.settings.boundVault.trim();
  if (!vaultName || plugin.settings.boundAccountId !== plugin.settings.accountId || /[\u0000-\u001f\u007f\\/]/.test(vaultName) || vaultName.length > 120) {
    throw new Error(t("needBind"));
  }
  await plugin.alignEncryptionWithRemote();
  const host = resolveSyncHost(plugin.settings.host);
  const keys = plugin.settings.encryptNotes ? await deriveKeys(requireSecret(plugin.settings.secretKey)) : null;
  return {
    host,
    client: new SyncClient(host, token, (seconds) => plugin.setStatus(t("retrying", { n: seconds }))),
    keys,
    vaultName,
  };
}

function requireSecret(secret: string): string {
  const value = secret.trim();
  if (value.length < MIN_SECRET_LENGTH) throw new Error(t("needSecret"));
  return value;
}

function writeBoundSettings(dest: string, boundVault: string, encryptNotes: boolean, accountId: string): void {
  const fs = nodeFs();
  const path = fs.resolve(dest, ".obsidian", "plugins", "e2ee-sync", "data.json");
  fs.mkdirSync(fs.dirname(path), { recursive: true });
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(fs.readText(path)) as Record<string, unknown>;
  } catch {
    current = {};
  }
  current.boundVault = boundVault;
  current.boundAccountId = accountId;
  current.encryptNotes = encryptNotes;
  fs.writeText(path, JSON.stringify(current, null, 2));
}

function createVaultDirectory(plugin: E2eeSyncPlugin, vaultName: string): string {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) throw new Error(t("desktopOnly"));
  const fs = nodeFs();
  const parent = fs.dirname(adapter.getBasePath());
  const folder = safeFolderName(vaultName);
  let dest = fs.resolve(parent, folder);
  const current = fs.resolve(adapter.getBasePath());
  if (dest === current || fs.existsSync(dest)) {
    const suffix = t("restoreFolder");
    dest = fs.resolve(parent, `${folder}-${suffix}`);
    let n = 2;
    while (dest === current || fs.existsSync(dest)) {
      dest = fs.resolve(parent, `${folder}-${suffix}-${n}`);
      n += 1;
    }
  }
  assertInside(parent, dest);
  fs.mkdirSync(dest, { recursive: true });
  return dest;
}

function writeOutside(dest: string, relative: string, data: Uint8Array): void {
  const fs = nodeFs();
  const full = fs.resolve(dest, ...relative.split("/"));
  assertInside(dest, full);
  fs.mkdirSync(fs.dirname(full), { recursive: true });
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  fs.writeFileSync(full, copy);
}

function assertInside(parent: string, target: string): void {
  const fs = nodeFs();
  const root = fs.resolve(parent);
  const full = fs.resolve(target);
  if (full !== root && !full.startsWith(root + fs.sep)) throw new Error(t("pathEscape"));
}

function installPluginCopy(plugin: E2eeSyncPlugin, dest: string): void {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return;
  const fs = nodeFs();
  const source = fs.resolve(adapter.getBasePath(), ".obsidian", "plugins", "e2ee-sync");
  const target = fs.resolve(dest, ".obsidian", "plugins", "e2ee-sync");
  fs.mkdirSync(target, { recursive: true });
  for (const file of ["manifest.json", "main.js", "styles.css"]) {
    fs.copyFile(fs.resolve(source, file), fs.resolve(target, file));
  }
  enablePlugin(fs, dest);
}

function enablePlugin(fs: NodeFs, dest: string): void {
  const listPath = fs.resolve(dest, ".obsidian", "community-plugins.json");
  let list: string[] = [];
  try {
    const parsed = JSON.parse(fs.readText(listPath)) as unknown;
    if (Array.isArray(parsed)) list = parsed.filter((item) => typeof item === "string");
  } catch {
    list = [];
  }
  if (list.includes("e2ee-sync")) return;
  list.push("e2ee-sync");
  fs.writeText(listPath, JSON.stringify(list, null, 2));
}

function registerVault(dest: string): void {
  if (!isDesktopApp()) return;
  const fs = nodeFs();
  const configDir = obsidianConfigDir();
  if (!configDir) {
    warnMissingObsidianConfig();
    return;
  }
  const configPath = fs.resolve(configDir, "obsidian.json");
  let parsed: { vaults?: Record<string, { path: string; ts: number; open?: boolean }> } = {};
  try {
    parsed = JSON.parse(fs.readText(configPath)) as typeof parsed;
  } catch {
    parsed = {};
  }
  parsed.vaults ??= {};
  const resolved = fs.resolve(dest);
  const existing = Object.entries(parsed.vaults).find(([, vault]) => fs.resolve(vault.path) === resolved);
  const id = existing?.[0] ?? [...randomBytes(8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  parsed.vaults[id] = { ...(existing?.[1] ?? {}), path: dest, ts: Date.now(), open: true };
  fs.writeText(configPath, JSON.stringify(parsed, null, 2));
}

function nodeFs(): NodeFs {
  const fs = require("fs") as unknown as {
    existsSync: (path: string) => boolean;
    mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
    writeFileSync: (path: string, data: Uint8Array | string) => void;
    readFileSync: (path: string, encoding: "utf8") => string;
    copyFileSync: (from: string, to: string) => void;
    statSync: (path: string) => { mtimeMs: number };
  };
  const path = require("path") as {
    sep: string;
    dirname: (path: string) => string;
    resolve: (...paths: string[]) => string;
  };
  return {
    sep: path.sep,
    existsSync: (target) => fs.existsSync(target),
    mkdirSync: (target, options) => fs.mkdirSync(target, options),
    writeFileSync: (target, data) => fs.writeFileSync(target, data),
    readText: (target) => fs.readFileSync(target, "utf8"),
    writeText: (target, data) => fs.writeFileSync(target, data),
    copyFile: (from, to) => fs.copyFileSync(from, to),
    statMtime: (target) => {
      try {
        return fs.statSync(target).mtimeMs;
      } catch {
        return 0;
      }
    },
    dirname: (target) => path.dirname(target),
    resolve: (...parts) => path.resolve(...parts),
  };
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 1024) return `${Math.max(0, Math.round(value))} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatStamp(ms: number): string {
  const date = new Date(ms);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function safeFolderName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/[. ]+$/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error(t("badFolder"));
  return cleaned;
}

interface NodeFs {
  sep: string;
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  writeFileSync: (path: string, data: Uint8Array) => void;
  readText: (path: string) => string;
  writeText: (path: string, data: string) => void;
  copyFile: (from: string, to: string) => void;
  statMtime: (path: string) => number;
  dirname: (path: string) => string;
  resolve: (...paths: string[]) => string;
}

declare function require(moduleName: string): NodeFs;

function safeVaultPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(t("badBackupPath"));
  }
  if (!isSyncablePath(normalized)) throw new Error(t("blockedPath", { path: normalized }));
  return normalized;
}

async function writeVaultFile(vault: Vault, path: string, data: Uint8Array): Promise<void> {
  const folders = path.split("/");
  folders.pop();
  let current = "";
  for (const folder of folders) {
    current = current ? `${current}/${folder}` : folder;
    if (!vault.getAbstractFileByPath(current)) {
      try {
        await vault.createFolder(current);
      } catch (error) {
        if (!vault.getAbstractFileByPath(current)) throw error;
      }
    }
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const buffer = copy.buffer;
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await vault.modifyBinary(existing, buffer);
    return;
  }
  if (existing) throw new Error(t("folderConflict", { path }));
  await vault.createBinary(path, buffer);
}
