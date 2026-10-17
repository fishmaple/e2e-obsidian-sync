import { Modal, Notice, PluginSettingTab, Setting, type App } from "obsidian";
import { bytesToBase64Url, randomBytes, randomSecret } from "../../shared/src/codec";
import { PUBLIC_SERVER_HOST } from "../../shared/src/protocol";
import { SyncClient, fetchBootstrap, fetchHealth, openExternal, resolveSyncHost } from "./client";
import { t } from "./i18n";
import { canSealSecrets } from "./local-secret";
import { sharedConfigProblem } from "./shared-config";
import { hasActiveBinding } from "./binding";
import type E2eeSyncPlugin from "./main";

export class E2eeSettingTab extends PluginSettingTab {
  private keyInput: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(private readonly plugin: E2eeSyncPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: t("title") });
    containerEl.createEl("p", { text: t("intro"), cls: "e2ee-sync-status-line" });
    containerEl.createEl("p", { text: t("dontCommit"), cls: "e2ee-sync-status-line" });
    if (!canSealSecrets()) containerEl.createEl("p", { text: t("secretsPlain"), cls: "e2ee-sync-status-line" });
    if (sharedConfigProblem()) containerEl.createEl("p", { text: t("sharedMissing"), cls: "e2ee-sync-status-line" });

    const host = new Setting(containerEl)
      .setName(t("host"))
      .setDesc(t("hostDesc", { host: PUBLIC_SERVER_HOST }));
    host.nameEl.createSpan({ text: " *", cls: "e2ee-sync-star" });
    host.addText((text) => {
      text.setPlaceholder(PUBLIC_SERVER_HOST)
        .setValue(this.plugin.settings.host)
        .onChange(async (value) => {
          this.plugin.settings.host = value.trim();
          await this.plugin.saveSettings();
        });
      host.addButton((button) => {
        button.setButtonText(t("resetHost")).onClick(async () => {
          this.plugin.settings.host = "";
          text.setValue("");
          await this.plugin.saveSettings();
        });
      });
    });

    new Setting(containerEl)
      .setName(t("accessToken"))
      .setDesc(t("accessTokenDesc"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(t("accessToken"))
          .setValue(this.plugin.settings.accessToken)
          .onChange(async (value) => {
            this.plugin.settings.accessToken = value.trim();
            await this.plugin.saveSettings();
          });
      });

    const loggedIn = Boolean(this.plugin.settings.apiToken.trim());
    const account = new Setting(containerEl).setName(t("account"));
    account.descEl.addClass("e2ee-sync-account");
    if (!loggedIn) {
      account.setDesc(t("notLoggedIn"));
      account.addButton((button) => {
        button.setButtonText(t("login")).setCta().onClick(() => {
          void this.login();
        });
      });
      containerEl.createEl("p", { text: t("loginDesc"), cls: "e2ee-sync-status-line" });
    } else {
      account.setDesc("");
      account.descEl.createDiv({ text: t("accountNameLine", { name: this.plugin.settings.displayName || t("none") }) });
      account.descEl.createDiv({ text: t("accountIdLine", { id: this.plugin.settings.accountId }) });
      account.addButton((button) => {
        button.setButtonText(t("logout")).onClick(() => {
          this.confirmLogout();
        });
      });
      void this.refreshProfile();
    }

    new Setting(containerEl)
      .setName(t("openSite"))
      .setDesc(t("openSiteDesc"))
      .addButton((button) => {
        button.setButtonText(t("openSite")).onClick(() => {
          void this.openSite();
        });
      });

    const encrypt = new Setting(containerEl)
      .setName(t("encrypt"))
      .setDesc(this.plugin.settings.encryptNotes ? t("encryptOn") : t("encryptDesc"));
    if (this.plugin.settings.encryptNotes) {
      encrypt.addText((text) => {
        text.inputEl.type = "password";
        this.keyInput = text.inputEl;
        text.setPlaceholder(t("secret"))
          .setValue(this.plugin.settings.secretKey)
          .onChange(async (value) => {
            const previous = this.plugin.settings.secretKey;
            this.plugin.setSecret(value);
            await this.plugin.saveSettings();
            this.plugin.refreshLiveStatus();
            if (previous.trim().length < 16 && value.trim().length >= 16 && this.plugin.settings.boundVault) {
              void this.plugin.syncNow(true);
            }
          });
      });
      encrypt.addButton((button) => {
        button.setButtonText(t("generate")).onClick(async () => {
          const secret = randomSecret();
          if (this.keyInput) {
            this.keyInput.type = "text";
            this.keyInput.value = secret;
          }
          this.plugin.setSecret(secret);
          await this.plugin.saveSettings();
          this.plugin.refreshLiveStatus();
          await navigator.clipboard.writeText(secret).catch(() => undefined);
          new Notice(t("generated"), 10000);
          if (this.plugin.settings.boundVault) void this.plugin.syncNow(true);
        });
      });
      encrypt.addButton((button) => {
        button.setButtonText(t("show")).onClick(() => {
          if (!this.keyInput) return;
          const hidden = this.keyInput.type === "password";
          this.keyInput.type = hidden ? "text" : "password";
          button.setButtonText(hidden ? t("hide") : t("show"));
        });
      });
    }
    encrypt.addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.encryptNotes).onChange(async (value) => {
        if (!value) {
          if (this.plugin.settings.encryptNotes) {
            toggle.setValue(true);
            new Notice(t("encryptLocked"));
          }
          return;
        }
        if (!hasActiveBinding(this.plugin.settings)) {
          toggle.setValue(false);
          new Notice(t("encryptNeedsBind"));
          return;
        }
        if (this.plugin.settings.encryptNotes) return;
        const ok = await confirmEncrypt(this.app);
        if (!ok) {
          toggle.setValue(false);
          return;
        }
        await new SyncClient(resolveSyncHost(this.plugin.settings.host), this.plugin.settings.apiToken).ensureVault(this.plugin.settings.boundVault, true);
        this.plugin.settings.encryptNotes = true;
        this.plugin.settings.index = {};
        await this.plugin.saveSettings();
        this.display();
        if (this.plugin.settings.secretKey.trim().length >= 16 && this.plugin.settings.boundVault) {
          void this.plugin.syncNow(true);
        } else {
          new Notice(t("fillKeyThenSync"));
        }
      });
    });

    const vaults = new Setting(containerEl)
      .setName(t("vaultList"))
      .setDesc(hasActiveBinding(this.plugin.settings)
        ? `${t("bound")}：${this.plugin.settings.boundVault}`
        : t("vaultListDesc"));
    vaults.addButton((button) => {
      button.setButtonText(t("bindNew")).onClick(() => {
        void this.bindNew();
      });
    });
    const vaultBox = containerEl.createDiv({ cls: "e2ee-sync-vault-list" });
    void this.renderVaults(vaultBox);

    new Setting(containerEl)
      .setName(t("autoSync"))
      .setDesc(t("autoSyncDesc"))
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
          this.plugin.reschedule();
        });
      })
      .addText((text) => {
        text.setPlaceholder("30")
          .setValue(String(this.plugin.settings.autoSyncSeconds))
          .onChange(async (value) => {
            const seconds = Number(value);
            if (!Number.isInteger(seconds) || seconds < 30 || seconds > 86400) return;
            if (seconds === this.plugin.settings.autoSyncSeconds) return;
            this.plugin.settings.autoSyncSeconds = seconds;
            await this.plugin.saveSettings();
            this.plugin.reschedule();
          });
      });

    const lastSync = new Setting(containerEl)
      .setName(t("lastSync"))
      .setDesc(lastSyncText(this.plugin));
    this.plugin.onSyncMeta = () => {
      lastSync.setDesc(lastSyncText(this.plugin));
    };

    new Setting(containerEl)
      .setName(t("actions"))
      .addButton((button) => button.setButtonText(t("test")).onClick(() => { void this.testConnection(); }))
      .addButton((button) => button.setButtonText(t("syncNow")).setCta().onClick(() => { void this.plugin.syncNow(true); }))
      .addButton((button) => button.setButtonText(t("restore")).onClick(() => { this.plugin.confirmRestore(); }));

    this.statusEl = containerEl.createDiv({ cls: "e2ee-sync-status-line" });
    this.statusEl.setText(this.plugin.settings.lastSyncSummary || t("notSynced"));
    this.plugin.onStatus = (text) => {
      this.statusEl?.setText(text);
    };
    this.plugin.onAccountFilled = () => {
      this.display();
    };
  }

  hide(): void {
    this.plugin.onStatus = undefined;
    this.plugin.onAccountFilled = undefined;
    this.plugin.onSyncMeta = undefined;
    super.hide();
  }

  private async refreshProfile(): Promise<void> {
    const token = this.plugin.settings.apiToken.trim();
    if (!token) return;
    try {
      const profile = await new SyncClient(resolveSyncHost(this.plugin.settings.host), token).profile();
      const name = profile.displayName.trim();
      if (!name || name === this.plugin.settings.displayName) return;
      this.plugin.settings.displayName = name;
      await this.plugin.saveSettings();
      this.display();
    } catch {
      // Older servers do not expose the account name.
    }
  }

  private confirmLogout(): void {
    new LogoutConfirm(this.app, (ok) => {
      if (ok) void this.logout();
    }).open();
  }

  private async logout(): Promise<void> {
    const token = this.plugin.settings.apiToken.trim();
    if (token) {
      try {
        await new SyncClient(resolveSyncHost(this.plugin.settings.host), token).logout();
      } catch {
        // The remote token may already be invalid. Clear the local login anyway.
      }
    }
    if (this.plugin.settings.boundVault && this.plugin.settings.accountId && !this.plugin.settings.boundAccountId) {
      this.plugin.settings.boundAccountId = this.plugin.settings.accountId;
    }
    this.plugin.settings.apiToken = "";
    this.plugin.settings.accountId = "";
    this.plugin.settings.displayName = "";
    this.plugin.settings.encryptNotes = false;
    await this.plugin.saveSettings();
    this.plugin.refreshRibbon();
    new Notice(t("loggedOut"));
    this.display();
  }

  private async bindNew(): Promise<void> {
    try {
      const name = this.plugin.app.vault.getName().trim();
      if (!name || /[\u0000-\u001f\u007f\\/]/.test(name) || name.length > 120) throw new Error(t("badVaultName"));
      const token = this.plugin.settings.apiToken.trim();
      if (!token) throw new Error(t("needLogin"));
      const remote = await new SyncClient(resolveSyncHost(this.plugin.settings.host), token).ensureVault(name);
      await this.bindTo(remote.name, remote.encrypted);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("needBind"));
    }
  }

  private async bindTo(name: string, encrypted: boolean): Promise<void> {
    const switched = this.plugin.settings.boundVault !== name || this.plugin.settings.boundAccountId !== this.plugin.settings.accountId;
    if (switched || this.plugin.settings.encryptNotes !== encrypted) this.plugin.settings.index = {};
    this.plugin.settings.boundVault = name;
    this.plugin.settings.boundAccountId = this.plugin.settings.accountId;
    this.plugin.settings.encryptNotes = encrypted;
    await this.plugin.saveSettings();
    if (encrypted && this.plugin.settings.secretKey.trim().length < 16) new Notice(t("fillKeyThenSync"));
    this.display();
  }

  private async unbind(): Promise<void> {
    this.plugin.settings.boundVault = "";
    this.plugin.settings.boundAccountId = "";
    this.plugin.settings.encryptNotes = false;
    await this.plugin.saveSettings();
    this.display();
  }

  private async renderVaults(box: HTMLElement): Promise<void> {
    const token = this.plugin.settings.apiToken.trim();
    if (!token) {
      box.setText(t("notLoggedIn"));
      return;
    }
    try {
      const host = resolveSyncHost(this.plugin.settings.host);
      const changed = await this.plugin.alignEncryptionWithRemote();
      if (changed) {
        this.display();
        return;
      }
      const { vaults } = await new SyncClient(host, token).vaults();
      box.empty();
      if (vaults.length === 0) {
        box.setText(t("noBackups"));
        return;
      }
      for (const vault of vaults) {
        const row = new Setting(box)
          .setName(vault.name)
          .setDesc(`${vault.files} · ${vault.encrypted ? t("encryptedLabel") : t("plainLabel")}`);
        row.addButton((button) => {
          const selected = hasActiveBinding(this.plugin.settings) && vault.name === this.plugin.settings.boundVault;
          button.setButtonText(selected ? t("unbind") : t("bind")).onClick(() => {
            if (selected) void this.unbind();
            else void this.bindTo(vault.name, vault.encrypted);
          });
        });
      }
    } catch (error) {
      box.setText(error instanceof Error ? error.message : t("needLogin"));
    }
  }

  private async openSite(): Promise<void> {
    try {
      const host = resolveSyncHost(this.plugin.settings.host);
      const token = this.plugin.settings.apiToken.trim();
      if (!token) throw new Error(t("loginFirst"));
      const { code } = await new SyncClient(host, token).webSession();
      openExternal(`${host}/account/enter?code=${encodeURIComponent(code)}`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("cannotOpen"));
    }
  }

  private async login(): Promise<void> {
    try {
      const host = resolveSyncHost(this.plugin.settings.host);
      const boot = await fetchBootstrap(host, this.plugin.settings.accessToken, true);
      if (boot.mode === "single" && boot.accountId && boot.apiToken) {
        this.plugin.setLogin(boot.accountId, boot.apiToken, boot.displayName ?? "");
        await this.plugin.saveSettings();
        new Notice(t("loggedIn"));
        this.display();
        return;
      }
      const state = bytesToBase64Url(randomBytes(32));
      const vault = this.plugin.app.vault.getName();
      this.plugin.armLogin(host, state);
      const url = new URL("/login", host);
      url.searchParams.set("return", "obsidian");
      url.searchParams.set("state", state);
      url.searchParams.set("vault", vault);
      openExternal(url.toString());
      new Notice(t("loginBrowser"));
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("loginFailed"));
    }
  }

  private async testConnection(): Promise<void> {
    try {
      const host = resolveSyncHost(this.plugin.settings.host);
      const health = await fetchHealth(host);
      const mode = health.oidc ? t("modeSso") : health.devLogin ? t("modeDev") : t("modeOk");
      const token = this.plugin.settings.apiToken.trim();
      if (!token) {
        new Notice(t("reachable", { mode }));
        return;
      }
      const listed = await new SyncClient(host, token).vaults();
      const files = listed.vaults.reduce((sum, vault) => sum + vault.files, 0);
      const names = listed.vaults.map((vault) => vault.name).join(", ") || t("none");
      this.plugin.settings.lastSyncSummary = t("connected", { vaults: listed.vaults.length, files, names });
      await this.plugin.saveSettings();
      this.statusEl?.setText(this.plugin.settings.lastSyncSummary);
      new Notice(this.plugin.settings.lastSyncSummary);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("connectionFailed"));
    }
  }
}

function lastSyncText(plugin: E2eeSyncPlugin): string {
  const at = plugin.settings.lastSyncAt;
  if (!at) return t("notSynced");
  return formatSyncTime(at);
}

function formatSyncTime(ms: number): string {
  const date = new Date(ms);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function confirmEncrypt(app: App): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new EncryptWarning(app, resolve);
    modal.open();
  });
}

class LogoutConfirm extends Modal {
  private settled = false;

  constructor(app: App, private readonly choose: (ok: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("logoutTitle"));
    this.contentEl.createEl("p", { text: t("logoutBody") });
    const row = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
    const ok = row.createEl("button", { text: t("logout"), cls: "mod-warning" });
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

class EncryptWarning extends Modal {
  private settled = false;

  constructor(app: App, private readonly choose: (ok: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("encryptTitle"));
    this.contentEl.createEl("p", { text: t("encryptWarn") });
    const list = this.contentEl.createEl("ol");
    list.createEl("li", { text: t("losePreview") });
    list.createEl("li", { text: t("loseShare") });
    const row = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
    const ok = row.createEl("button", { text: t("encryptContinue"), cls: "mod-warning" });
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
