import { FileSystemAdapter, Modal, Notice, TFile, type App, type Vault } from "obsidian";
import { bytesToBase64, randomBytes } from "../../shared/src/codec";
import { contentMac, deriveKeys, fileIdForPath, openBytes, plainFileId, plainMac, sealBytes } from "../../shared/src/crypto";
import { MAX_FILE_BYTES, MIN_SECRET_LENGTH, type Encoding, type RemoteFile, type VaultStat } from "../../shared/src/protocol";
import { SyncClient, fetchBootstrap, openExternal, resolveSyncHost } from "./client";
import { suffixSelected } from "./file-kinds";
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
  const files = plugin.app.vault.getFiles().filter((file) => shouldSync(plugin, file.path));
  const manifest = await ready.client.manifest(ready.vaultId);
  const remote = new Map(manifest.files.map((file) => [file.fileId, file]));
  const seen = new Set<string>();
  const index = { ...plugin.settings.index };
  let uploaded = 0;
  let downloaded = 0;
  let unchanged = 0;
  const skippedLarge: string[] = [];
  const now = Date.now();

  for (const file of files) {
    const fileId = ready.keys
      ? await fileIdForPath(ready.keys.idKey, file.path, ready.vaultName)
      : await plainFileId(ready.vaultName, file.path);
    seen.add(fileId);
    const cached = index[fileId];
    const remoteFile = remote.get(fileId);
    const plain = new Uint8Array(await plugin.app.vault.readBinary(file));
    const mac = ready.keys ? await contentMac(ready.keys.idKey, plain) : await plainMac(plain);
    if (remoteFile?.contentMac === mac && remoteFile.encoding === encoding) {
      index[fileId] = { path: file.path, mtime: file.stat.mtime, size: file.stat.size, contentMac: mac, encoding, syncedAt: cached?.syncedAt ?? now };
      unchanged++;
      continue;
    }
    if (remoteFile && remoteFile.mtime > file.stat.mtime) {
      if (await pullRemote(plugin, ready, remoteFile, index)) downloaded++;
      else unchanged++;
      plugin.setStatus(t("syncProgress", { done: uploaded + downloaded + unchanged, total: files.length + remote.size }));
      continue;
    }
    if (file.stat.size > MAX_FILE_BYTES) {
      skippedLarge.push(file.path);
      continue;
    }
    await ready.client.putObject(fileId, {
      vault: ready.vaultName,
      vaultId: ready.vaultId,
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
    plugin.setStatus(t("syncProgress", { done: uploaded + downloaded + unchanged, total: files.length + remote.size }));
  }

  for (const remoteFile of remote.values()) {
    if (seen.has(remoteFile.fileId)) continue;
    if (await pullRemote(plugin, ready, remoteFile, index)) downloaded++;
    plugin.setStatus(t("syncProgress", { done: uploaded + downloaded + unchanged, total: files.length + remote.size }));
  }

  plugin.settings.index = index;
  const large = skippedLarge.length ? t("large", { n: skippedLarge.length }) : "";
  plugin.settings.lastSyncSummary = t("summary", {
    vault: ready.vaultName,
    uploaded,
    downloaded,
    unchanged,
    large,
  });
  await plugin.saveSettings();
  return plugin.settings.lastSyncSummary;
}

async function pullRemote(
  plugin: E2eeSyncPlugin,
  ready: Awaited<ReturnType<typeof openClient>>,
  remoteFile: RemoteFile,
  index: E2eeSyncPlugin["settings"]["index"],
): Promise<boolean> {
  if (remoteFile.size > MAX_FILE_BYTES) return false;
  const known = index[remoteFile.fileId]?.path;
  if (known && !shouldSync(plugin, known)) return false;
  const stored = await ready.client.getObject(remoteFile.fileId);
  const path = safeVaultPath(new TextDecoder().decode(
    await openBytes(ready.keys?.encKey ?? null, stored.pathCipher, `path:${remoteFile.fileId}`),
  ));
  if (!shouldSync(plugin, path)) return false;
  const data = await openBytes(ready.keys?.encKey ?? null, stored.contentCipher, `body:${remoteFile.fileId}`);
  await writeVaultFile(plugin.app.vault, path, data);
  stampMtime(plugin, path, remoteFile.mtime);
  index[remoteFile.fileId] = {
    path,
    mtime: remoteFile.mtime,
    size: data.byteLength,
    contentMac: remoteFile.contentMac,
    encoding: remoteFile.encoding,
    syncedAt: Date.now(),
  };
  return true;
}

function shouldSync(plugin: E2eeSyncPlugin, path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (PLUGIN_FILES.has(normalized)) return true;
  if (!isSyncablePath(normalized)) return false;
  return suffixSelected(normalized, plugin.settings.syncSuffixes, plugin.settings.syncOther);
}

export async function restoreVault(
  plugin: E2eeSyncPlugin,
  remote: { id: string; name: string },
  mode: RestoreMode,
  folder = "",
): Promise<string> {
  const token = plugin.settings.apiToken.trim();
  if (!token) throw new Error(t("needLogin"));
  const vaultName = remote.name.trim();
  const vaultId = remote.id.trim();
  if (!vaultName || !vaultId) throw new Error(t("needBind"));
  const host = resolveSyncHost(plugin.settings.host);
  const client = new SyncClient(host, token, (seconds) => plugin.setStatus(t("retrying", { n: seconds })));
  const manifest = await client.manifest(vaultId);
  const needsKey = manifest.files.some((file) => file.encoding === "e2ee");
  if (needsKey && plugin.settings.secretKey.trim().length < MIN_SECRET_LENGTH) throw new Error(t("needSecret"));
  const keys = needsKey ? await deriveKeys(requireSecret(plugin.settings.secretKey)) : null;
  const destination = mode === "create" ? prepareRestoreFolder(plugin, folder) : "";
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
    await plugin.bindVault(vaultName, needsKey, vaultId);
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
    writeBoundSettings(destination, vaultName, vaultId, needsKey, plugin.settings.accountId);
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
  private vaults: VaultStat[] = [];

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
      const token = this.plugin.settings.apiToken.trim();
      if (!token) throw new Error(t("needLogin"));
      const host = resolveSyncHost(this.plugin.settings.host);
      const listed = await new SyncClient(host, token).vaults();
      this.render(listed.vaults.filter((vault) => vault.id && vault.name));
    } catch (error) {
      this.contentEl.empty();
      this.contentEl.createEl("p", { text: error instanceof Error ? error.message : t("readFailed") });
    }
  }

  private render(vaults: VaultStat[]): void {
    this.contentEl.empty();
    this.vaults = vaults;
    if (vaults.length === 0) {
      this.contentEl.createEl("p", { text: t("noBackups") });
      return;
    }
    this.selected = vaults[0]?.id ?? "";
    this.contentEl.createEl("p", { text: t("restoreHelp") });
    this.contentEl.createEl("p", { text: t("restoreCurrent", { name: this.plugin.app.vault.getName() }) });
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
        this.selected = vault.id;
        for (const item of rows) item.toggleClass("is-selected", item === row);
      };
      rows.push(row);
    }
    rows[0]?.addClass("is-selected");
    const actions = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
    const overwrite = actions.createEl("button", { text: t("overwrite"), cls: "mod-warning" });
    overwrite.onclick = () => this.choose("overwrite");
    const create = actions.createEl("button", { text: t("createVault") });
    create.onclick = () => { void this.chooseCreate(); };
    const cancel = actions.createEl("button", { text: t("cancel") });
    cancel.onclick = () => this.close();
  }

  private choose(mode: RestoreMode): void {
    const remote = this.vaults.find((vault) => vault.id === this.selected);
    if (!remote) return;
    this.close();
    void this.plugin.restoreNow(remote, mode);
  }

  private async chooseCreate(): Promise<void> {
    const remote = this.vaults.find((vault) => vault.id === this.selected);
    if (!remote) return;
    const folder = await chooseRestoreFolder(this.app);
    if (!folder) return;
    const name = folderName(folder);
    if (!name || vaultNameTaken(folder)) {
      new Notice(t("restoreNameTaken", { name: name || folder }));
      return;
    }
    if (folderHasFiles(folder)) {
      const ok = await confirmOverwrite(this.app);
      if (!ok) return;
    }
    this.close();
    void this.plugin.restoreNow(remote, "create", folder);
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
  vaultId: string;
}> {
  const token = plugin.settings.apiToken.trim();
  if (!token) throw new Error(t("needLogin"));
  const vaultName = plugin.settings.boundVault.trim();
  const vaultId = plugin.settings.boundVaultId.trim();
  if (!vaultName || !vaultId || plugin.settings.boundAccountId !== plugin.settings.accountId || /[\u0000-\u001f\u007f\\/]/.test(vaultName) || vaultName.length > 120) {
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
    vaultId,
  };
}

function requireSecret(secret: string): string {
  const value = secret.trim();
  if (value.length < MIN_SECRET_LENGTH) throw new Error(t("needSecret"));
  return value;
}

function writeBoundSettings(dest: string, boundVault: string, boundVaultId: string, encryptNotes: boolean, accountId: string): void {
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
  current.boundVaultId = boundVaultId;
  current.boundAccountId = accountId;
  const bindings = current.vaultBindings && typeof current.vaultBindings === "object"
    ? current.vaultBindings as Record<string, unknown>
    : {};
  bindings[accountId] = { vaultId: boundVaultId, vaultName: boundVault, encryptNotes };
  current.vaultBindings = bindings;
  current.encryptNotes = encryptNotes;
  fs.writeText(path, JSON.stringify(current, null, 2));
}

function prepareRestoreFolder(plugin: E2eeSyncPlugin, folder: string): string {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) throw new Error(t("desktopOnly"));
  const fs = nodeFs();
  const dest = fs.resolve(folder);
  if (!dest || vaultNameTaken(dest)) throw new Error(t("restoreNameTaken", { name: folderName(dest) || dest }));
  fs.mkdirSync(dest, { recursive: true });
  return dest;
}

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function vaultNameTaken(folder: string): boolean {
  const fs = nodeFs();
  const dest = fs.resolve(folder);
  const name = folderName(dest).toLowerCase();
  if (!name || name === "." || name === "..") return true;
  const configDir = obsidianConfigDir();
  if (!configDir) return false;
  try {
    const parsed = JSON.parse(fs.readText(fs.resolve(configDir, "obsidian.json"))) as {
      vaults?: Record<string, { path?: string }>;
    };
    for (const vault of Object.values(parsed.vaults ?? {})) {
      if (typeof vault.path !== "string" || !vault.path) continue;
      const existing = fs.resolve(vault.path);
      if (existing.toLowerCase() === dest.toLowerCase()) return true;
      if (folderName(existing).toLowerCase() === name) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function folderHasFiles(folder: string): boolean {
  const fs = nodeFs();
  if (!fs.existsSync(folder)) return false;
  return fs.list(folder).some((name) => name !== ".DS_Store");
}

function chooseRestoreFolder(app: App): Promise<string> {
  const picked = pickDirectory();
  if (picked) return picked;
  return askFolderPath(app);
}

function pickDirectory(): Promise<string> | null {
  try {
    const electron = require("electron") as {
      dialog?: { showOpenDialog: (options: { properties: string[] }) => Promise<{ canceled?: boolean; filePaths?: string[] }> };
      remote?: { dialog?: { showOpenDialog: (options: { properties: string[] }) => Promise<{ canceled?: boolean; filePaths?: string[] }> } };
    };
    const dialog = electron.dialog ?? electron.remote?.dialog;
    if (!dialog) return null;
    return dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }).then((result) => {
      if (result.canceled || !result.filePaths?.[0]) return "";
      return result.filePaths[0];
    });
  } catch {
    return null;
  }
}

function askFolderPath(app: App): Promise<string> {
  return new Promise((resolve) => {
    const modal = new FolderPathModal(app, resolve);
    modal.open();
  });
}

function confirmOverwrite(app: App): Promise<boolean> {
  return new Promise((resolve) => {
    new OverwriteFolderConfirm(app, resolve).open();
  });
}

class FolderPathModal extends Modal {
  private settled = false;
  private input: HTMLInputElement | null = null;

  constructor(app: App, private readonly choose: (path: string) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("restorePickFolder"));
    this.contentEl.createEl("p", { text: t("restoreFolderPath") });
    this.input = this.contentEl.createEl("input", { type: "text" });
    this.input.style.width = "100%";
    const row = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
    const ok = row.createEl("button", { text: t("createVault"), cls: "mod-cta" });
    ok.onclick = () => this.finish(this.input?.value.trim() ?? "");
    const cancel = row.createEl("button", { text: t("cancel") });
    cancel.onclick = () => this.finish("");
  }

  onClose(): void {
    this.finish("");
  }

  private finish(path: string): void {
    if (this.settled) return;
    this.settled = true;
    this.choose(path);
    this.close();
  }
}

class OverwriteFolderConfirm extends Modal {
  private settled = false;

  constructor(app: App, private readonly choose: (ok: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("createVault"));
    this.contentEl.createEl("p", { text: t("restoreNotEmpty") });
    const row = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
    const ok = row.createEl("button", { text: t("restoreOverwriteFiles"), cls: "mod-warning" });
    ok.onclick = () => this.finish(true);
    const cancel = row.createEl("button", { text: t("cancel") });
    cancel.onclick = () => this.finish(false);
  }

  onClose(): void {
    this.finish(false);
  }

  private finish(ok: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.choose(ok);
    this.close();
  }
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
    utimesSync: (path: string, atime: Date, mtime: Date) => void;
    readdirSync: (path: string) => string[];
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
    utimes: (target, ms) => {
      const when = new Date(ms);
      fs.utimesSync(target, when, when);
    },
    list: (target) => {
      try {
        return fs.readdirSync(target);
      } catch {
        return [];
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

interface NodeFs {
  sep: string;
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  writeFileSync: (path: string, data: Uint8Array) => void;
  readText: (path: string) => string;
  writeText: (path: string, data: string) => void;
  copyFile: (from: string, to: string) => void;
    statMtime: (path: string) => number;
    utimes: (path: string, ms: number) => void;
    list: (path: string) => string[];
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

function stampMtime(plugin: E2eeSyncPlugin, path: string, mtime: number): void {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter) || !Number.isFinite(mtime) || mtime <= 0) return;
  const fs = nodeFs();
  const full = fs.resolve(adapter.getBasePath(), ...path.split("/"));
  try {
    fs.utimes(full, mtime);
  } catch (error) {
    console.warn("Could not keep the synced file time", error);
  }
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
