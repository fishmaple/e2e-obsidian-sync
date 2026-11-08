import { Notice, Plugin, TFile, type ObsidianProtocolData } from "obsidian";
import { clampAutoVersionLimit } from "../../shared/src/history";
import { normalizeCheckpointRetries, type CheckpointRetry } from "./checkpoint-retry";
import { MIN_SECRET_LENGTH } from "../../shared/src/protocol";
import { SyncClient, SessionExpiredError, exchangeLogin, resolveSyncHost } from "./client";
import { clampMaxFileBytes, clampNonNegative, clampTrashDays } from "./limits";
import { offerGitignore } from "./gitignore-prompt";
import { t } from "./i18n";
import { openLocal, sealLocal } from "./local-secret";
import { applySharedConfig, readSharedConfig, shouldAdoptSharedLogin, vaultHasLogin, writeSharedConfig } from "./shared-config";
import { promptBind } from "./bind-prompt";
import { hasActiveBinding } from "./binding";
import { allSuffixes } from "./file-kinds";
import { FileHistoryModal } from "./history";
import { E2eeSettingTab } from "./settings";
import { formatLiveStatus, normalizeSyncMode, passForPull, passForSync, shouldNoticePendingPull, showsPullCommand, statusBarActivatesPull, type SyncMode } from "./sync-mode";
import { RestoreModal, clampTransferParallel, isSyncablePath, propagatePlugin, pushVault, restoreVault, type RestoreMode } from "./sync";

export interface FileIndexEntry {
  path: string;
  mtime: number;
  size: number;
  contentMac: string;
  encoding?: "e2ee" | "plain";
  syncedAt?: number;
  /** Last revision successfully synced with the server. */
  rev?: number;
  /** The path changed locally and still needs to be uploaded. */
  pathDirty?: boolean;
}

export interface VaultBinding {
  vaultId: string;
  vaultName: string;
  encryptNotes: boolean;
}

export interface SyncSettings {
  host: string;
  accountId: string;
  displayName: string;
  apiToken: string;
  secretKey: string;
  accessToken: string;
  encryptNotes: boolean;
  boundVault: string;
  boundVaultId: string;
  boundAccountId: string;
  vaultBindings: Record<string, VaultBinding>;
  /**
   * Per vault. Plugin data already lives with the vault, so this is not stored
   * on vaultBindings (that map is only the account's remote vault).
   */
  syncMode: SyncMode;
  /** Remote content mode A did not apply. Zero in mode B. */
  pendingPullCount: number;
  /**
   * This vault logged out or the session expired. An empty login then stays
   * empty instead of taking the shared login on the next launch.
   */
  skipSharedLogin: boolean;
  autoSync: boolean;
  autoSyncSeconds: number;
  transferParallel: number;
  excludePatterns: string[];
  maxFileBytes: number;
  vaultMaxFiles: number;
  vaultMaxBytes: number;
  trashDays: number;
  trashMaxFiles: number;
  conflictPolicy: "ask" | "snapshot" | "overwrite";
  /** Default auto-version retention applied to files without their own limit. */
  autoVersionLimit: number;
  /** Per-file auto retention overrides. Manual caps stay on the server. */
  versionLimitOverrides: Record<string, number>;
  /** Checkpoints that failed after the tip was stored. One latest tip per file. */
  checkpointRetries: Record<string, CheckpointRetry>;
  syncSuffixes: string[];
  customSuffixes: string[];
  syncOther: boolean;
  lastSyncAt: number | null;
  lastSyncSummary: string;
  gitignorePrompted: boolean;
  /** Change-log cursor for the bound vault. Null until a full snapshot has been applied. */
  changeCursor: number | null;
  index: Record<string, FileIndexEntry>;
}

const DEFAULT_SETTINGS: SyncSettings = {
  host: "",
  accountId: "",
  displayName: "",
  apiToken: "",
  secretKey: "",
  accessToken: "",
  encryptNotes: false,
  boundVault: "",
  boundVaultId: "",
  boundAccountId: "",
  vaultBindings: {},
  syncMode: "bidirectional",
  pendingPullCount: 0,
  skipSharedLogin: false,
  autoSync: true,
  autoSyncSeconds: 30,
  transferParallel: 10,
  excludePatterns: [],
  maxFileBytes: 32 * 1024 * 1024,
  vaultMaxFiles: 0,
  vaultMaxBytes: 0,
  trashDays: 30,
  trashMaxFiles: 200,
  conflictPolicy: "snapshot",
  autoVersionLimit: 100,
  versionLimitOverrides: {},
  checkpointRetries: {},
  syncSuffixes: allSuffixes(),
  customSuffixes: [],
  syncOther: true,
  lastSyncAt: null,
  lastSyncSummary: "",
  gitignorePrompted: false,
  changeCursor: null,
  index: {},
};

export default class E2eeSyncPlugin extends Plugin {
  settings: SyncSettings = structuredClone(DEFAULT_SETTINGS);
  onStatus?: (text: string) => void;
  private syncing = false;
  private pending = false;
  private pendingPull = false;
  private loginToken = 0;
  private stopTimer: (() => void) | null = null;
  private statusBar: HTMLElement | null = null;
  private ribbonEl: HTMLElement | null = null;
  private dirtyPaths = new Set<string>();
  private pendingLogin: { host: string; state: string; expiresAt: number } | null = null;
  onAccountFilled?: (accountId: string) => void;
  onSyncMeta?: () => void;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new E2eeSettingTab(this));
    this.ribbonEl = this.addRibbonIcon("refresh-cw", t("syncNow"), () => {
      void this.syncNow(true);
    });
    this.ribbonEl.addClass("e2ee-sync-ribbon");
    this.refreshRibbon();
    this.app.workspace.onLayoutReady(() => this.pinRibbonToBottom());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.pinRibbonToBottom()));
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("mod-clickable");
    this.statusBar.addClass("e2ee-sync-live");
    this.statusBar.onclick = () => {
      if (statusBarActivatesPull(this.settings.syncMode, this.settings.pendingPullCount)) void this.pullNow(true);
      else void this.syncNow(true);
    };
    this.refreshLiveStatus();
    this.registerObsidianProtocolHandler("e2ee-sync", (params) => {
      void this.completeProtocolLogin(params);
    });

    this.addCommand({
      id: "sync-now",
      name: t("commandSync"),
      callback: () => {
        void this.syncNow(true);
      },
    });
    this.addCommand({
      id: "pull-remote",
      name: t("commandPull"),
      checkCallback: (checking) => {
        if (!showsPullCommand(this.settings.syncMode)) return false;
        if (!checking) void this.pullNow(true);
        return true;
      },
    });
    this.addCommand({
      id: "restore",
      name: t("commandRestore"),
      callback: () => {
        this.confirmRestore();
      },
    });
    this.addCommand({
      id: "file-history",
      name: t("commandHistory"),
      callback: () => {
        this.openFileHistory();
      },
    });

    const bump = () => {
      const file = this.app.workspace.getActiveFile();
      if (file) this.dirtyPaths.delete(file.path);
      this.refreshLiveStatus();
    };
    this.registerEvent(this.app.vault.on("create", bump));
    this.registerEvent(this.app.vault.on("modify", bump));
    this.registerEvent(this.app.vault.on("delete", bump));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) {
        for (const entry of Object.values(this.settings.index)) {
          if (entry.path !== oldPath) continue;
          entry.path = file.path;
          entry.pathDirty = true;
          entry.mtime = file.stat.mtime;
          entry.size = file.stat.size;
          break;
        }
        this.dirtyPaths.delete(oldPath);
        if (isSyncablePath(file.path)) this.dirtyPaths.add(file.path);
        void this.saveSettings();
      }
      this.refreshLiveStatus();
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshLiveStatus()));
    this.registerEvent(this.app.workspace.on("editor-change", () => {
      const file = this.app.workspace.getActiveFile();
      if (file && isSyncablePath(file.path)) this.dirtyPaths.add(file.path);
      this.refreshLiveStatus();
    }));
    this.register(() => {
      this.loginToken++;
      this.stopTimer?.();
    });
    this.reschedule();
    this.spreadPlugin();
    offerGitignore(this);
  }

  async loadSettings(): Promise<void> {
    const stored = await this.loadData() as Record<string, unknown> | null;
    const storedHadLoginField = stored != null && (
      Object.prototype.hasOwnProperty.call(stored, "accountId")
      || Object.prototype.hasOwnProperty.call(stored, "apiToken")
      || Object.prototype.hasOwnProperty.call(stored, "apiTokenBox")
    );
    const legacyPlain = Boolean(stored && (typeof stored.secretKey === "string" || typeof stored.apiToken === "string"));
    const secretKey = openLocal(stored?.secretKeyBox) || (typeof stored?.secretKey === "string" ? stored.secretKey : "");
    const apiToken = openLocal(stored?.apiTokenBox) || (typeof stored?.apiToken === "string" ? stored.apiToken : "");
    const rest: Record<string, unknown> = { ...(stored ?? {}) };
    const legacyDebounce = typeof rest.debounceSeconds === "number" ? rest.debounceSeconds : 30;
    const legacyInterval = typeof rest.intervalMinutes === "number" ? rest.intervalMinutes : 5;
    const hadAutoSync = typeof rest.autoSync === "boolean";
    const hadAutoSyncSeconds = typeof rest.autoSyncSeconds === "number";
    delete rest.secretKey;
    delete rest.secretKeyBox;
    delete rest.apiToken;
    delete rest.apiTokenBox;
    delete rest.debounceSeconds;
    delete rest.intervalMinutes;
    delete rest.lastSyncKind;
    this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...rest, secretKey, apiToken };
    if (!hadAutoSync) this.settings.autoSync = true;
    if (!hadAutoSyncSeconds) {
      const seconds = legacyDebounce > 0 ? legacyDebounce : legacyInterval * 60;
      this.settings.autoSyncSeconds = clampAutoSyncSeconds(seconds);
    } else {
      this.settings.autoSyncSeconds = clampAutoSyncSeconds(this.settings.autoSyncSeconds);
    }
    const parallel = this.settings.transferParallel;
    this.settings.transferParallel = clampTransferParallel(typeof parallel === "number" ? parallel : 10);
    this.settings.excludePatterns = Array.isArray(rest.excludePatterns)
      ? rest.excludePatterns.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 200)
      : [];
    this.settings.maxFileBytes = clampMaxFileBytes(rest.maxFileBytes);
    this.settings.vaultMaxFiles = clampNonNegative(rest.vaultMaxFiles, 0, 1_000_000);
    this.settings.vaultMaxBytes = clampNonNegative(rest.vaultMaxBytes, 0, 1024 * 1024 * 1024 * 1024);
    this.settings.trashDays = clampTrashDays(rest.trashDays);
    this.settings.trashMaxFiles = clampNonNegative(rest.trashMaxFiles, 200, 100_000);
    this.settings.conflictPolicy = rest.conflictPolicy === "ask" || rest.conflictPolicy === "overwrite" ? rest.conflictPolicy : "snapshot";
    this.settings.syncMode = normalizeSyncMode(rest.syncMode);
    const storedPending = rest.pendingPullCount;
    this.settings.pendingPullCount = typeof storedPending === "number" && Number.isSafeInteger(storedPending) && storedPending > 0
      ? Math.min(storedPending, 1_000_000)
      : 0;
    this.settings.skipSharedLogin = rest.skipSharedLogin === true;
    const storedLimit = rest.autoVersionLimit;
    this.settings.autoVersionLimit = clampAutoVersionLimit(typeof storedLimit === "number" ? storedLimit : 100);
    this.settings.versionLimitOverrides = normalizeVersionLimits(rest.versionLimitOverrides);
    this.settings.checkpointRetries = normalizeCheckpointRetries(rest.checkpointRetries);
    const known = new Set(allSuffixes());
    const storedCustom = rest.customSuffixes;
    const custom = Array.isArray(storedCustom)
      ? [...new Set(storedCustom.filter((item): item is string => typeof item === "string" && !known.has(item) && /^[a-z0-9]{1,16}$/.test(item)))]
      : [];
    this.settings.customSuffixes = custom;
    const allowed = new Set([...known, ...custom]);
    const storedSuffixes = rest.syncSuffixes;
    this.settings.syncSuffixes = Array.isArray(storedSuffixes)
      ? storedSuffixes.filter((item): item is string => typeof item === "string" && allowed.has(item))
      : allSuffixes();
    if (typeof rest.syncOther !== "boolean") this.settings.syncOther = true;
    this.settings.index ??= {};
    const storedCursor = rest.changeCursor;
    this.settings.changeCursor = typeof storedCursor === "number" && Number.isSafeInteger(storedCursor) && storedCursor >= 0
      ? storedCursor
      : null;
    this.settings.boundVaultId = typeof rest.boundVaultId === "string" ? rest.boundVaultId : "";
    this.settings.vaultBindings = normalizeBindings(rest.vaultBindings);
    const shared = readSharedConfig();
    applySharedConfig(this.settings, shared.config, {
      applyLogin: shouldAdoptSharedLogin({
        hasLogin: vaultHasLogin(this.settings),
        skipSharedLogin: this.settings.skipSharedLogin,
        storedHadLoginField,
      }),
    });
    if (this.settings.boundVault && this.settings.accountId && !this.settings.boundAccountId) {
      this.settings.boundAccountId = this.settings.accountId;
    }
    if (!hasActiveBinding(this.settings)) this.settings.encryptNotes = false;
    if (legacyPlain || shared.hadPlaintext) await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    writeSharedConfig(this.settings, "seed");
    const { secretKey, apiToken, ...rest } = this.settings;
    await this.saveData({
      ...rest,
      secretKeyBox: sealLocal(secretKey),
      apiTokenBox: sealLocal(apiToken),
    });
  }

  spreadPlugin(): void {
    try {
      const installed = propagatePlugin(this);
      for (const path of installed) {
        const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
        new Notice(t("propagated", { name }));
      }
    } catch (error) {
      console.warn("Could not install the plugin into other vaults", error);
    }
  }

  openSettings(): void {
    const setting = (this.app as unknown as {
      setting: { open: () => void; openTabById: (id: string) => void };
    }).setting;
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  refreshRibbon(): void {
    if (!this.ribbonEl) return;
    this.ribbonEl.setAttribute("aria-label", t("syncNow"));
    this.ribbonEl.setAttribute("aria-label-position", "right");
  }

  private pinRibbonToBottom(): void {
    const icon = this.ribbonEl;
    if (!icon) return;
    const bottom = this.app.workspace.containerEl.querySelector(".workspace-ribbon.mod-left .side-dock-settings");
    if (!(bottom instanceof HTMLElement)) return;
    if (icon.parentElement !== bottom || bottom.lastElementChild !== icon) bottom.append(icon);
  }

  setAccountId(value: string): void {
    const next = value.trim();
    if (next !== this.settings.accountId) {
      this.clearFileIndex();
      this.settings.apiToken = "";
    }
    this.settings.accountId = next;
    this.refreshRibbon();
  }

  setLogin(accountId: string, apiToken: string, displayName = ""): void {
    this.settings.skipSharedLogin = !accountId.trim() && !apiToken.trim();
    const previous = this.settings.accountId;
    if (previous && previous !== accountId) this.rememberBinding(previous);
    this.settings.accountId = accountId;
    this.settings.apiToken = apiToken;
    this.settings.displayName = displayName || (accountId === previous ? this.settings.displayName : "");
    const saved = this.settings.vaultBindings[accountId];
    if (saved?.vaultId) {
      if (saved.vaultId !== this.settings.boundVaultId) this.clearFileIndex();
      this.settings.boundVaultId = saved.vaultId;
      this.settings.boundVault = saved.vaultName;
      this.settings.boundAccountId = accountId;
      this.settings.encryptNotes = saved.encryptNotes;
    } else if (this.settings.boundAccountId === accountId && (this.settings.boundVaultId || this.settings.boundVault)) {
      this.rememberBinding(accountId);
    } else {
      if (this.settings.boundVaultId || this.settings.boundVault) this.clearFileIndex();
      this.clearBinding();
    }
    this.refreshRibbon();
  }

  rememberBinding(accountId = this.settings.accountId): void {
    if (!accountId) return;
    if (!this.settings.boundVaultId && !this.settings.boundVault) return;
    if (this.settings.boundAccountId && this.settings.boundAccountId !== accountId) return;
    this.settings.vaultBindings[accountId] = {
      vaultId: this.settings.boundVaultId,
      vaultName: this.settings.boundVault,
      encryptNotes: this.settings.encryptNotes,
    };
  }

  clearBinding(): void {
    this.settings.boundVault = "";
    this.settings.boundVaultId = "";
    this.settings.boundAccountId = "";
    this.settings.encryptNotes = false;
  }

  async alignEncryptionWithRemote(): Promise<boolean> {
    const encrypted = await this.remoteEncrypted();
    if (this.settings.encryptNotes === encrypted) return false;
    if (encrypted) this.clearFileIndex();
    this.settings.encryptNotes = encrypted;
    await this.saveSettings();
    return true;
  }

  private async remoteEncrypted(): Promise<boolean> {
    if (!hasActiveBinding(this.settings)) return false;
    const host = resolveSyncHost(this.settings.host);
    const { vaults } = await new SyncClient(host, this.settings.apiToken).vaults();
    const match = this.settings.boundVaultId
      ? vaults.find((vault) => vault.id === this.settings.boundVaultId)
      : vaults.find((vault) => vault.name === this.settings.boundVault);
    return Boolean(match?.encrypted);
  }

  async refreshBoundIdentity(): Promise<void> {
    if (!this.settings.apiToken.trim() || this.settings.boundAccountId !== this.settings.accountId) return;
    if (!this.settings.boundVaultId && !this.settings.boundVault) return;
    const host = resolveSyncHost(this.settings.host);
    const { vaults } = await new SyncClient(host, this.settings.apiToken).vaults();
    const match = this.settings.boundVaultId
      ? vaults.find((vault) => vault.id === this.settings.boundVaultId)
      : vaults.find((vault) => vault.name === this.settings.boundVault);
    if (!match?.id) return;
    if (match.id === this.settings.boundVaultId && match.name === this.settings.boundVault && match.encrypted === this.settings.encryptNotes) return;
    await this.bindVault(match.name, match.encrypted, match.id);
  }

  async bindVault(name: string, encrypted: boolean, vaultId: string): Promise<void> {
    const switched = this.settings.boundVaultId !== vaultId || this.settings.boundAccountId !== this.settings.accountId;
    if (switched || this.settings.encryptNotes !== encrypted) this.clearFileIndex();
    this.settings.boundVault = name;
    this.settings.boundVaultId = vaultId;
    this.settings.boundAccountId = this.settings.accountId;
    this.settings.encryptNotes = encrypted;
    this.rememberBinding();
    await this.saveSettings();
    if (encrypted && this.settings.secretKey.trim().length < MIN_SECRET_LENGTH) new Notice(t("fillKeyThenSync"));
  }

  setSecret(value: string): void {
    if (value !== this.settings.secretKey) this.clearFileIndex();
    this.settings.secretKey = value;
  }

  armLogin(host: string, state: string): void {
    this.pendingLogin = { host, state, expiresAt: Date.now() + 5 * 60 * 1000 };
  }

  async completeProtocolLogin(params: ObsidianProtocolData): Promise<void> {
    const pending = this.pendingLogin;
    this.pendingLogin = null;
    const code = params.code ?? "";
    const state = params.state ?? "";
    if (!pending || pending.expiresAt < Date.now()) {
      new Notice(t("loginTimeout"));
      return;
    }
    if (!code || state !== pending.state) {
      new Notice(t("loginMismatch"));
      return;
    }
    try {
      const result = await exchangeLogin(pending.host, code, state);
      if (!result.accountId || !result.apiToken) throw new Error(t("loginEmpty"));
      this.setLogin(result.accountId, result.apiToken, result.displayName ?? "");
      await this.saveSettings();
      await this.refreshBoundIdentity();
      await this.alignEncryptionWithRemote();
      this.onAccountFilled?.(result.accountId);
      new Notice(t("loggedIn"));
      if (!hasActiveBinding(this.settings)) promptBind(this);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("loginReturnFailed"));
    }
  }

  beginLogin(): number {
    this.loginToken += 1;
    return this.loginToken;
  }

  isLoginCurrent(token: number): boolean {
    return token === this.loginToken;
  }

  reschedule(): void {
    this.stopTimer?.();
    this.armAutoTimer();
  }

  private armAutoTimer(): void {
    if (!this.settings.autoSync) {
      this.stopTimer = null;
      return;
    }
    const wait = clampAutoSyncSeconds(this.settings.autoSyncSeconds);
    this.settings.autoSyncSeconds = wait;
    let cancel: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      void this.syncNow(false).finally(() => {
        if (this.stopTimer !== cancel) return;
        this.armAutoTimer();
      });
    }, wait * 1000);
    cancel = () => window.clearTimeout(timer);
    this.stopTimer = cancel;
  }

  /**
   * `settings` updates the settings line and leaves the status bar alone, so a
   * finished summary cannot cover the pending-pull cue.
   */
  setStatus(text: string, target: "all" | "settings" = "all"): void {
    if (target === "all") {
      const short = text.length > 80 ? `${text.slice(0, 80)}…` : text;
      this.statusBar?.setText(short);
      this.statusBar?.removeClass("is-pending-pull");
    }
    this.onStatus?.(text);
  }

  /** Write this vault's login over the shared file. Does nothing when logged out. */
  publishSharedLogin(): boolean {
    if (!vaultHasLogin(this.settings)) return false;
    return writeSharedConfig(this.settings, "replace");
  }

  /** Opt in to the shared login after this vault has logged out. */
  useSharedLogin(): boolean {
    if (vaultHasLogin(this.settings)) return false;
    const shared = readSharedConfig().config;
    if (!shared || !vaultHasLogin(shared)) return false;
    if (!this.settings.host.trim() && shared.host?.trim()) this.settings.host = shared.host;
    if (!this.settings.accessToken.trim() && shared.accessToken) this.settings.accessToken = shared.accessToken;
    if (!this.settings.secretKey && shared.secretKey) this.setSecret(shared.secretKey);
    this.setLogin(shared.accountId ?? "", shared.apiToken ?? "", shared.displayName ?? "");
    return true;
  }

  refreshLiveStatus(): void {
    if (this.syncing || !this.statusBar) return;
    const byPath = new Map<string, FileIndexEntry>();
    for (const entry of Object.values(this.settings.index)) {
      if (entry.path) byPath.set(entry.path, entry);
    }
    const files = this.app.vault.getFiles().filter((file) => isSyncablePath(file.path));
    let pending = 0;
    let synced = 0;
    for (const file of files) {
      if (this.isPending(file.path, file.stat.mtime, file.stat.size, byPath.get(file.path))) pending++;
      else synced++;
    }
    const active = this.app.workspace.getActiveFile();
    let current = "";
    if (active && isSyncablePath(active.path)) {
      const entry = byPath.get(active.path);
      if (this.isPending(active.path, active.stat.mtime, active.stat.size, entry)) {
        current = ` · ${t("thisPending")}`;
      } else if (entry?.syncedAt) {
        current = ` · ${t("thisSynced", { time: formatStamp(entry.syncedAt) })}`;
      }
    }
    const pullFirst = statusBarActivatesPull(this.settings.syncMode, this.settings.pendingPullCount);
    this.statusBar.setText(formatLiveStatus({
      pendingPull: pullFirst ? t("pendingPull", { n: this.settings.pendingPullCount }) : "",
      pending: t("pending", { n: pending }),
      synced: t("synced", { n: synced }),
      current,
      pullFirst,
    }));
    if (pullFirst) this.statusBar.addClass("is-pending-pull");
    else this.statusBar.removeClass("is-pending-pull");
    const label = pullFirst ? t("pendingPullClick") : t("syncNow");
    this.statusBar.setAttribute("aria-label", label);
    this.statusBar.setAttribute("title", label);
  }

  clearFileIndex(): void {
    this.settings.index = {};
    this.settings.changeCursor = null;
    this.settings.pendingPullCount = 0;
  }

  private isPending(path: string, mtime: number, size: number, entry: FileIndexEntry | undefined): boolean {
    if (this.dirtyPaths.has(path)) return true;
    if (!entry?.syncedAt) return true;
    return entry.mtime !== mtime || entry.size !== size;
  }

  async syncNow(manual: boolean): Promise<boolean> {
    return this.runBoundSync(manual, "sync");
  }

  async pullNow(manual: boolean): Promise<boolean> {
    return this.runBoundSync(manual, "pull");
  }

  private async runBoundSync(manual: boolean, intent: "sync" | "pull"): Promise<boolean> {
    if (this.syncing) {
      if (manual) {
        this.pending = true;
        this.pendingPull = intent === "pull";
        new Notice(t("syncing"));
      }
      return false;
    }
    if (!this.settings.apiToken.trim()) {
      if (manual) new Notice(t("needLogin"));
      this.refreshLiveStatus();
      return false;
    }
    if (!hasActiveBinding(this.settings)) {
      if (manual) new Notice(t("needBind"));
      this.refreshLiveStatus();
      return false;
    }
    if (this.settings.encryptNotes && this.settings.secretKey.trim().length < MIN_SECRET_LENGTH) {
      if (manual) new Notice(t("fillKeyThenSync"));
      this.refreshLiveStatus();
      return false;
    }
    this.settings.lastSyncAt = Date.now();
    this.onSyncMeta?.();
    this.syncing = true;
    this.setStatus(intent === "pull" ? t("pullingNow") : t("syncingNow"));
    const pass = intent === "pull" ? passForPull(this.settings.syncMode) : passForSync(this.settings.syncMode);
    const pendingBefore = this.settings.pendingPullCount;
    try {
      const summary = await pushVault(this, manual ? "manual" : "auto", pass);
      this.setStatus(summary, "settings");
      if (manual) new Notice(summary);
      if (shouldNoticePendingPull({
        pass,
        before: pendingBefore,
        after: this.settings.pendingPullCount,
        manual,
      })) {
        new Notice(t("pendingPullNotice", { n: this.settings.pendingPullCount }), 10000);
      }
      return true;
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        this.setLogin("", "", "");
        await this.saveSettings();
      }
      const message = error instanceof Error ? error.message : t("syncFailed");
      this.settings.lastSyncSummary = message;
      await this.saveSettings();
      this.setStatus(message);
      if (manual) new Notice(message);
      return false;
    } finally {
      this.syncing = false;
      this.refreshLiveStatus();
      this.followQueued();
    }
  }

  private followQueued(): void {
    const pull = this.pendingPull;
    this.pendingPull = false;
    if (!this.pending) return;
    this.pending = false;
    if (pull) void this.pullNow(false);
    else void this.syncNow(false);
  }

  confirmRestore(): void {
    new RestoreModal(this.app, this).open();
  }

  openFileHistory(): void {
    new FileHistoryModal(this.app, this).open();
  }

  markClean(path: string): void {
    this.dirtyPaths.delete(path);
    this.refreshLiveStatus();
  }

  async restoreNow(remote: { id: string; name: string }, mode: RestoreMode, folder = ""): Promise<void> {
    if (this.syncing) {
      new Notice(t("syncBusy"));
      return;
    }
    this.syncing = true;
    this.setStatus(t("restoring"));
    try {
      const summary = await restoreVault(this, remote, mode, folder);
      this.setStatus(summary);
      new Notice(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("restoreFailed");
      this.setStatus(message);
      new Notice(message);
    } finally {
      this.syncing = false;
      this.refreshLiveStatus();
      this.followQueued();
    }
  }
}

function normalizeVersionLimits(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const limits: Record<string, number> = {};
  for (const [fileId, raw] of Object.entries(value)) {
    if (!/^[0-9a-f]{64}$/.test(fileId) || typeof raw !== "number") continue;
    limits[fileId] = clampAutoVersionLimit(raw);
  }
  return limits;
}

function normalizeBindings(value: unknown): Record<string, VaultBinding> {
  if (!value || typeof value !== "object") return {};
  const bindings: Record<string, VaultBinding> = {};
  for (const [accountId, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as { vaultId?: unknown; vaultName?: unknown; encryptNotes?: unknown };
    if (typeof row.vaultId !== "string" || typeof row.vaultName !== "string") continue;
    bindings[accountId] = {
      vaultId: row.vaultId,
      vaultName: row.vaultName,
      encryptNotes: row.encryptNotes === true,
    };
  }
  return bindings;
}

export function clampAutoSyncSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return 30;
  return Math.min(86400, Math.max(30, Math.floor(seconds)));
}

function formatStamp(ms: number): string {
  const date = new Date(ms);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
