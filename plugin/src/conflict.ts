import { Modal, type App } from "obsidian";
import { mergeTexts } from "../../shared/src/merge";
import { t } from "./i18n";

export interface ConflictView {
  index: number;
  total: number;
  path: string;
  kind: "content" | "remote-deleted" | "local-deleted";
  localText: string | null;
  remoteText: string | null;
  baseRev: number | null;
  baseMac: string | null;
  remoteRev: number | null;
  remoteMac: string | null;
}

export type ConflictChoice =
  | { action: "local" }
  | { action: "remote" }
  | { action: "both" }
  | { action: "merge"; text: string }
  | { action: "skip" };

export function askConflict(app: App, view: ConflictView): Promise<ConflictChoice> {
  return new Promise((resolve) => {
    new ConflictModal(app, view, resolve).open();
  });
}

export function previewMerge(local: string, remote: string, base: string | null): { text: string; threeWay: boolean } {
  return mergeTexts(local, remote, base);
}

class ConflictModal extends Modal {
  private settled = false;
  private editing = false;
  private mergeInput: HTMLTextAreaElement | null = null;
  private actionsEl: HTMLElement | null = null;
  private followEl: HTMLElement | null = null;
  private editSaveRow: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly view: ConflictView,
    private readonly choose: (choice: ConflictChoice) => void,
  ) {
    super(app);
  }

  private canMerge(): boolean {
    return this.view.kind === "content" && this.view.localText !== null && this.view.remoteText !== null;
  }

  onOpen(): void {
    this.modalEl.addClass("e2ee-sync-conflict-modal");
    this.titleEl.setText(t("conflictTitle", { index: this.view.index, total: this.view.total }));
    const { view } = this;
    this.contentEl.createEl("p", { text: this.lead() });
    this.contentEl.createEl("p", {
      text: view.baseRev && view.baseMac
        ? t("conflictBaseLine", { rev: view.baseRev, mac: shortMac(view.baseMac) })
        : t("conflictBaseUnknown"),
      cls: "e2ee-sync-status-line",
    });
    if (view.remoteRev && view.remoteMac) {
      this.contentEl.createEl("p", {
        text: t("conflictRemoteLine", { rev: view.remoteRev, mac: shortMac(view.remoteMac) }),
        cls: "e2ee-sync-status-line",
      });
    }
    const canMerge = view.kind === "content" && view.localText !== null && view.remoteText !== null;
    if (view.kind === "content" && view.localText !== null && view.remoteText !== null) {
      const columns = this.contentEl.createDiv({ cls: "e2ee-sync-conflict-columns" });
      this.column(columns, t("conflictLocal"), view.localText);
      this.column(columns, t("conflictRemote"), view.remoteText);
    } else if (view.kind === "content") {
      this.contentEl.createEl("p", { text: t("conflictBinary") });
    }
    if (canMerge) {
      const merged = previewMerge(view.localText ?? "", view.remoteText ?? "", null);
      this.contentEl.createEl("p", { text: merged.threeWay ? t("conflictThreeWay") : t("conflictTwoWay"), cls: "e2ee-sync-status-line" });
      this.mergeInput = this.contentEl.createEl("textarea", { cls: "e2ee-sync-merge" });
      this.mergeInput.value = merged.text;
      this.mergeInput.hidden = true;
    }
    this.actionsEl = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
    this.showMainActions();
  }

  private showMainActions(): void {
    if (!this.actionsEl) return;
    if (this.followEl) this.followEl.hidden = true;
    if (this.editSaveRow) this.editSaveRow.hidden = !this.editing;
    if (this.mergeInput) this.mergeInput.hidden = !this.editing;
    const actions = this.actionsEl;
    actions.empty();
    const { view } = this;
    if (view.kind === "content") {
      this.button(actions, t("conflictKeepLocal"), () => this.finish({ action: "local" }));
      this.button(actions, t("conflictUseRemote"), () => this.finish({ action: "remote" }), true);
      this.button(actions, t("conflictKeepBoth"), () => this.showKeepBoth());
      if (this.canMerge()) {
        const edit = this.button(actions, t("conflictEdit"), () => this.openEditor());
        edit.addClass("mod-cta");
      }
    } else if (view.kind === "remote-deleted") {
      this.button(actions, t("conflictKeepLocal"), () => this.finish({ action: "local" }), true);
      this.button(actions, t("conflictDeleteLocal"), () => this.finish({ action: "remote" }));
    } else {
      this.button(actions, t("conflictRestoreRemote"), () => this.finish({ action: "remote" }), true);
      this.button(actions, t("conflictDeleteRemote"), () => this.finish({ action: "local" }));
    }
    this.button(actions, t("conflictSkip"), () => this.finish({ action: "skip" }));
  }

  private showKeepBoth(): void {
    if (!this.actionsEl) return;
    if (!this.followEl) {
      this.followEl = this.contentEl.createDiv({ cls: "e2ee-sync-both" });
      this.actionsEl.before(this.followEl);
    }
    this.followEl.hidden = false;
    this.followEl.empty();
    this.followEl.createEl("h3", { text: t("conflictBothTitle") });
    this.followEl.createEl("p", { text: t("conflictBothHelp") });
    if (this.canMerge()) {
      this.followEl.createEl("p", {
        text: t("conflictBothSameFileDesc", { path: this.view.path }),
        cls: "e2ee-sync-status-line",
      });
    } else {
      this.followEl.createEl("p", { text: t("conflictBothBinary"), cls: "e2ee-sync-status-line" });
    }
    this.followEl.createEl("p", { text: t("conflictBothNewFileDesc"), cls: "e2ee-sync-status-line" });
    if (this.mergeInput && !this.editing) this.mergeInput.hidden = true;
    if (this.editSaveRow) this.editSaveRow.hidden = true;
    const actions = this.actionsEl;
    actions.empty();
    const same = this.button(actions, t("conflictBothSameFile"), () => {
      if (this.canMerge()) this.keepBothInFile();
    });
    if (this.canMerge()) same.addClass("mod-cta");
    else if (same instanceof HTMLButtonElement) same.disabled = true;
    this.button(actions, t("conflictBothNewFile"), () => this.finish({ action: "both" }));
    this.button(actions, t("conflictBothBack"), () => this.showMainActions());
  }

  private keepBothInFile(): void {
    if (!this.mergeInput || !this.actionsEl || !this.canMerge()) return;
    this.mergeInput.hidden = false;
    if (this.editSaveRow) this.editSaveRow.hidden = true;
    this.mergeInput.focus();
    const actions = this.actionsEl;
    actions.empty();
    const save = this.button(actions, t("conflictSaveMerge"), () => {
      this.finish({ action: "merge", text: this.mergeInput?.value ?? "" });
    });
    save.addClass("mod-cta");
    this.button(actions, t("conflictBothBack"), () => this.showKeepBoth());
  }

  onClose(): void {
    this.finish({ action: "skip" });
  }

  private lead(): string {
    if (this.view.kind === "remote-deleted") return t("conflictRemoteDeleted", { path: this.view.path });
    if (this.view.kind === "local-deleted") return t("conflictLocalDeleted", { path: this.view.path });
    return t("conflictContent", { path: this.view.path });
  }

  private column(parent: HTMLElement, title: string, text: string): void {
    const box = parent.createDiv();
    box.createEl("div", { text: title });
    const pre = box.createEl("pre", { cls: "e2ee-sync-conflict-pre" });
    pre.setText(text);
  }

  private button(parent: HTMLElement, text: string, onClick: () => void, warning = false): HTMLElement {
    const button = parent.createEl("button", { text });
    if (warning) button.addClass("mod-warning");
    button.onclick = onClick;
    return button;
  }

  private openEditor(): void {
    if (!this.mergeInput || this.editing) return;
    this.editing = true;
    this.mergeInput.hidden = false;
    this.editSaveRow = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
    const save = this.editSaveRow.createEl("button", { text: t("conflictSaveMerge"), cls: "mod-cta" });
    save.onclick = () => this.finish({ action: "merge", text: this.mergeInput?.value ?? "" });
  }

  private finish(choice: ConflictChoice): void {
    if (this.settled) return;
    this.settled = true;
    this.choose(choice);
    this.close();
  }
}

function shortMac(mac: string): string {
  return mac.slice(0, 8);
}
