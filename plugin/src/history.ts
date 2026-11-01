import { Modal, Notice, TFile, type App } from "obsidian";
import { fileIdForPath, openBytes, plainFileId } from "../../shared/src/crypto";
import {
  clampAutoVersionLimit,
  diffVersionText,
  groupVersionsByDay,
  previousChangedDayPair,
  type FileVersionInfo,
  type RetentionView,
  type TextDiffLine,
  type VersionDayGroup,
} from "../../shared/src/history";
import { SyncClient, SyncConflictError, resolveSyncHost } from "./client";
import { t } from "./i18n";
import type E2eeSyncPlugin from "./main";
import { applyRestoredFile, isSyncablePath, openBoundClient } from "./sync";

export class FileHistoryModal extends Modal {
  private filePath = "";
  private fileId = "";
  private versions: FileVersionInfo[] = [];
  private retention: RetentionView | null = null;
  private selected: string[] = [];
  private expanded = new Set<string>();
  private client: SyncClient | null = null;
  private vaultId = "";
  private keys: Awaited<ReturnType<typeof openBoundClient>>["keys"] = null;

  constructor(app: App, private readonly plugin: E2eeSyncPlugin) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("e2ee-sync-history-modal");
    this.titleEl.setText(t("historyTitle"));
    this.contentEl.setText(t("historyLoading"));
    void this.load();
  }

  private async load(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || !isSyncablePath(file.path)) {
      this.contentEl.empty();
      this.contentEl.createEl("p", { text: t("historyNeedFile") });
      return;
    }
    this.filePath = file.path;
    this.titleEl.setText(t("historyTitleNamed", { name: file.name }));
    try {
      const ready = await openBoundClient(this.plugin, "manual");
      this.client = ready.client;
      this.vaultId = ready.vaultId;
      this.keys = ready.keys;
      this.fileId = ready.keys
        ? await fileIdForPath(ready.keys.idKey, file.path, ready.vaultName)
        : await plainFileId(ready.vaultName, file.path);
      const listed = await ready.client.listVersions(this.fileId, ready.vaultId);
      this.versions = listed.versions;
      this.retention = listed.retention;
      this.render();
    } catch (error) {
      this.contentEl.empty();
      this.contentEl.createEl("p", { text: error instanceof Error ? error.message : t("historyFailed") });
    }
  }

  private render(): void {
    const offset = new Date().getTimezoneOffset();
    const days = groupVersionsByDay(this.versions, offset);
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: this.filePath, cls: "e2ee-sync-status-line" });
    this.renderRetention();
    if (this.plugin.settings.encryptNotes) {
      const wipe = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
      const button = wipe.createEl("button", { text: t("historyWipe"), cls: "mod-warning" });
      button.onclick = () => {
        void wipePlaintextHistory(this.plugin, () => { void this.load(); });
      };
    }
    this.contentEl.createEl("p", { text: t("historyPickTwo"), cls: "e2ee-sync-status-line" });
    const compare = this.contentEl.createEl("button", { text: t("historyCompare") });
    compare.disabled = this.selected.length !== 2;
    compare.onclick = () => { void this.compareSelected(); };
    if (days.length === 0) {
      this.contentEl.createEl("p", { text: t("historyEmpty") });
      return;
    }
    const list = this.contentEl.createDiv({ cls: "e2ee-sync-days" });
    for (const day of days) {
      const open = this.expanded.has(day.day);
      const row = list.createEl("button", { cls: "e2ee-sync-day" });
      row.createSpan({ text: daySummary(day) });
      row.setAttr("aria-expanded", open ? "true" : "false");
      row.onclick = () => {
        if (this.expanded.has(day.day)) this.expanded.delete(day.day);
        else this.expanded.add(day.day);
        this.render();
      };
      if (!open) continue;
      const body = list.createDiv({ cls: "e2ee-sync-day-body" });
      for (const version of day.versions) this.versionRow(body, version);
      const previous = previousChangedDayPair(days, day.day);
      const shortcut = body.createEl("button", { text: t("historyComparePrev") });
      shortcut.disabled = !previous;
      shortcut.onclick = () => {
        if (!previous) {
          new Notice(t("historyNoPrevDay"));
          return;
        }
        void this.compare(previous.older, previous.newer);
      };
      if (!previous) body.createEl("p", { text: t("historyNoPrevDay"), cls: "e2ee-sync-status-line" });
    }
  }

  private renderRetention(): void {
    const retention = this.retention;
    if (!retention) return;
    const box = this.contentEl.createDiv({ cls: "e2ee-sync-name" });
    box.createEl("div", { text: t("historyFileLimit") });
    box.createEl("p", { text: t("historyFileLimitDesc"), cls: "e2ee-sync-status-line" });
    const autoRow = box.createDiv({ cls: "e2ee-sync-actions" });
    const auto = autoRow.createEl("input", { type: "number" });
    auto.min = "1";
    auto.max = "256";
    auto.value = String(retention.autoLimit);
    const saveAuto = autoRow.createEl("button", { text: t("save") });
    saveAuto.onclick = () => { void this.saveAuto(Number(auto.value)); };
    const useDefault = autoRow.createEl("button", { text: t("historyUseDefault", { n: this.plugin.settings.autoVersionLimit }) });
    useDefault.onclick = () => { void this.saveAuto(this.plugin.settings.autoVersionLimit, true); };

    box.createEl("div", { text: t("historyManualLimit") });
    box.createEl("p", { text: t("historyManualLimitDesc"), cls: "e2ee-sync-status-line" });
    const manualRow = box.createDiv({ cls: "e2ee-sync-actions" });
    const manual = manualRow.createEl("input", { type: "number" });
    manual.min = "1";
    manual.max = "256";
    manual.placeholder = t("historyManualEmpty");
    if (retention.manualLimit !== null) manual.value = String(retention.manualLimit);
    const saveManual = manualRow.createEl("button", { text: t("save") });
    saveManual.onclick = () => {
      const raw = manual.value.trim();
      void this.saveManual(raw === "" ? null : Number(raw));
    };
  }

  private versionRow(parent: HTMLElement, version: FileVersionInfo): void {
    const row = parent.createDiv({ cls: "e2ee-sync-version" });
    const input = row.createEl("input", { type: "checkbox" });
    input.checked = this.selected.includes(version.versionId);
    input.onchange = () => {
      this.toggle(version.versionId);
      this.render();
    };
    row.createSpan({ text: versionLabel(version) });
    const restore = row.createEl("button", { text: t("historyRestore") });
    restore.onclick = () => {
      new RestoreVersionConfirm(this.app, () => { void this.restore(version); }).open();
    };
  }

  private toggle(versionId: string): void {
    const index = this.selected.indexOf(versionId);
    if (index >= 0) {
      this.selected.splice(index, 1);
      return;
    }
    this.selected.push(versionId);
    if (this.selected.length > 2) this.selected.shift();
  }

  private async saveAuto(raw: number, clearOverride = false): Promise<void> {
    if (!this.client || !Number.isInteger(raw)) return;
    const autoLimit = clampAutoVersionLimit(raw);
    try {
      this.retention = await this.client.saveRetention(this.fileId, { autoLimit });
      if (clearOverride) delete this.plugin.settings.versionLimitOverrides[this.fileId];
      else this.plugin.settings.versionLimitOverrides[this.fileId] = autoLimit;
      await this.plugin.saveSettings();
      this.render();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("historyFailed"));
    }
  }

  private async saveManual(raw: number | null): Promise<void> {
    if (!this.client) return;
    if (raw !== null && (!Number.isInteger(raw) || raw < 1 || raw > 256)) {
      new Notice(t("autoVersionLimitRange", { n: clampAutoVersionLimit(typeof raw === "number" ? raw : 100) }));
      return;
    }
    try {
      this.retention = await this.client.saveRetention(this.fileId, { manualLimit: raw });
      await this.plugin.saveSettings();
      new Notice(t("historyManualSaved"));
      this.render();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("historyFailed"));
    }
  }

  private async compareSelected(): Promise<void> {
    const chosen = this.selected
      .map((id) => this.versions.find((version) => version.versionId === id))
      .filter((version): version is FileVersionInfo => Boolean(version));
    if (chosen.length !== 2) return;
    const [first, second] = [...chosen].sort((a, b) => a.createdAt - b.createdAt);
    if (!first || !second) return;
    await this.compare(first, second);
  }

  private async compare(older: FileVersionInfo, newer: FileVersionInfo): Promise<void> {
    try {
      const [left, right] = await Promise.all([this.plainText(older), this.plainText(newer)]);
      if (left === null || right === null) {
        new DiffModal(this.app, t("historyDiffTitle"), null, t("historyDiffBinary")).open();
        return;
      }
      const diff = diffVersionText(left, right);
      if (diff === "too-large") {
        new DiffModal(this.app, t("historyDiffTitle"), null, t("historyDiffLarge")).open();
        return;
      }
      if (diff.every((line) => line.op === "eq")) {
        new DiffModal(this.app, t("historyDiffTitle"), null, t("historyDiffEmpty")).open();
        return;
      }
      new DiffModal(this.app, t("historyDiffTitle"), diff, "").open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("historyFailed"));
    }
  }

  private async restore(version: FileVersionInfo): Promise<void> {
    if (!this.client) return;
    try {
      const parentRev = await this.client.tipRevision(this.fileId, this.vaultId);
      const result = await this.client.restoreVersion(this.fileId, version.versionId, this.vaultId, parentRev);
      const bytes = await this.plainBytes(version);
      await applyRestoredFile(this.plugin, this.fileId, this.filePath, bytes, {
        mtime: version.mtime,
        contentMac: result.contentMac || version.contentMac,
        encoding: result.encoding,
        rev: result.rev,
      });
      new Notice(t("historyRestored"));
      await this.load();
    } catch (error) {
      if (error instanceof SyncConflictError) {
        new Notice(t("historyConflict"));
        return;
      }
      new Notice(error instanceof Error ? error.message : t("historyFailed"));
    }
  }

  private async plainText(version: FileVersionInfo): Promise<string | null> {
    const bytes = await this.plainBytes(version);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\u0000")) return null;
      return text;
    } catch {
      return null;
    }
  }

  private async plainBytes(version: FileVersionInfo): Promise<Uint8Array> {
    if (!this.client) throw new Error(t("historyFailed"));
    const listed = await this.client.versionDownloads(this.fileId, this.vaultId, [version.versionId]);
    const item = listed.downloads[0];
    if (!item) throw new Error(t("historyFailed"));
    const cipher = await this.client.fetchCipher(item.url);
    return openBytes(this.keys?.encKey ?? null, cipher, `body:${this.fileId}`);
  }
}

export function wipePlaintextHistory(plugin: E2eeSyncPlugin, after?: () => void): void {
  new WipePlainConfirm(plugin.app, (ok) => {
    if (ok) void runWipe(plugin, after);
  }).open();
}

async function runWipe(plugin: E2eeSyncPlugin, after?: () => void): Promise<void> {
  try {
    const token = plugin.settings.apiToken.trim();
    const vaultId = plugin.settings.boundVaultId.trim();
    if (!token || !vaultId) throw new Error(t("needBind"));
    const result = await new SyncClient(resolveSyncHost(plugin.settings.host), token).deletePlaintextHistory(vaultId);
    new Notice(t("wipePlainDone", { n: result.deleted }));
    after?.();
  } catch (error) {
    new Notice(error instanceof Error ? error.message : t("historyFailed"));
  }
}

function daySummary(day: VersionDayGroup): string {
  const vars = {
    day: day.day,
    count: day.count,
    auto: day.auto,
    manual: day.manual,
    restore: day.restore,
    bytes: formatBytes(day.bytes),
    from: clock(day.earliest),
    to: clock(day.latest),
  };
  return day.restore > 0 ? t("historyDayRestore", vars) : t("historyDaySummary", vars);
}

function versionLabel(version: FileVersionInfo): string {
  const trigger = version.syncTrigger === "manual"
    ? t("historyManual")
    : version.syncTrigger === "restore" ? t("historyRestoreTrigger") : t("historyAuto");
  const encoding = version.encoding === "plain" ? t("historyPlain") : t("historyEncrypted");
  return `${clock(version.createdAt)} · ${trigger} · ${encoding} · ${formatBytes(version.size)} · rev ${version.tipRev}`;
}

function clock(ms: number): string {
  const date = new Date(ms);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 1024) return `${Math.max(0, Math.round(value))} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

class DiffModal extends Modal {
  constructor(
    app: App,
    title: string,
    private readonly lines: TextDiffLine[] | null,
    private readonly note: string,
  ) {
    super(app);
    this.titleEl.setText(title);
  }

  onOpen(): void {
    this.modalEl.addClass("e2ee-sync-history-modal");
    if (this.note) this.contentEl.createEl("p", { text: this.note });
    if (!this.lines) return;
    const pre = this.contentEl.createDiv({ cls: "e2ee-sync-diff" });
    for (const line of this.lines) {
      const row = pre.createDiv({ cls: `e2ee-sync-diff-${line.op}` });
      const mark = line.op === "add" ? "+" : line.op === "del" ? "-" : " ";
      row.setText(`${mark} ${line.text}`);
    }
  }
}

class RestoreVersionConfirm extends Modal {
  private settled = false;

  constructor(app: App, private readonly choose: (ok: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("historyRestoreTitle"));
    this.contentEl.createEl("p", { text: t("historyRestoreBody") });
    const row = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
    const ok = row.createEl("button", { text: t("historyRestore"), cls: "mod-warning" });
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

class WipePlainConfirm extends Modal {
  private settled = false;

  constructor(app: App, private readonly choose: (ok: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("wipePlainTitle"));
    this.contentEl.createEl("p", { text: t("wipePlainBody") });
    const row = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
    const ok = row.createEl("button", { text: t("wipePlainHistory"), cls: "mod-warning" });
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
