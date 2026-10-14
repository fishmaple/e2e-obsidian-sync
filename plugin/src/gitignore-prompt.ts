import { FileSystemAdapter, Modal, type App } from "obsidian";
import { t } from "./i18n";
import type E2eeSyncPlugin from "./main";
import { isDesktopApp } from "./obsidian-dir";

const IGNORE_LINE = ".obsidian/plugins/e2ee-sync/data.json";

export function offerGitignore(plugin: E2eeSyncPlugin): void {
  if (plugin.settings.gitignorePrompted || !isDesktopApp()) return;
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return;
  const fs = require("fs") as {
    existsSync: (target: string) => boolean;
    readFileSync: (target: string, encoding: "utf8") => string;
    writeFileSync: (target: string, data: string) => void;
  };
  const path = require("path") as { join: (...parts: string[]) => string };
  const base = adapter.getBasePath();
  const ignorePath = path.join(base, ".gitignore");
  if (!fs.existsSync(path.join(base, ".git")) && !fs.existsSync(ignorePath)) return;
  let current = "";
  try {
    current = fs.readFileSync(ignorePath, "utf8");
  } catch {
    current = "";
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === IGNORE_LINE)) {
    plugin.settings.gitignorePrompted = true;
    void plugin.saveSettings();
    return;
  }
  new GitignoreModal(plugin.app, (accept) => {
    plugin.settings.gitignorePrompted = true;
    if (accept) {
      const next = current.length === 0 || current.endsWith("\n")
        ? `${current}${IGNORE_LINE}\n`
        : `${current}\n${IGNORE_LINE}\n`;
      fs.writeFileSync(ignorePath, next);
    }
    void plugin.saveSettings();
  }).open();
}

class GitignoreModal extends Modal {
  constructor(app: App, private readonly choose: (accept: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("gitignoreTitle"));
    this.contentEl.createEl("p", { text: t("gitignoreBody") });
    const row = this.contentEl.createDiv({ cls: "e2ee-sync-actions" });
    const yes = row.createEl("button", { text: t("gitignoreYes") });
    yes.addClass("mod-cta");
    yes.onclick = () => {
      this.choose(true);
      this.close();
    };
    const no = row.createEl("button", { text: t("gitignoreNo") });
    no.onclick = () => {
      this.choose(false);
      this.close();
    };
  }
}

declare function require(moduleName: string): unknown;
