import { Modal, Notice, Setting, type App } from "obsidian";
import { deriveKeys, openBytes } from "../../shared/src/crypto";
import type { PayloadCipher } from "../../shared/src/protocol";
import { SyncClient, resolveSyncHost } from "./client";
import { t } from "./i18n";
import type E2eeSyncPlugin from "./main";

interface TrashItem {
  fileId: string;
  pathCipher: PayloadCipher;
  deletedAt: number;
  size: number;
}

export class TrashModal extends Modal {
  constructor(app: App, private readonly plugin: E2eeSyncPlugin) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(t("trashTitle"));
    void this.render();
  }

  private async render(): Promise<void> {
    this.contentEl.empty();
    const token = this.plugin.settings.apiToken.trim();
    const vaultId = this.plugin.settings.boundVaultId.trim();
    if (!token || !vaultId) {
      this.contentEl.createEl("p", { text: t("needBind") });
      return;
    }
    const client = new SyncClient(resolveSyncHost(this.plugin.settings.host), token);
    let items: TrashItem[] = [];
    try {
      const listed = await client.listTrash(vaultId);
      items = listed.items;
    } catch (error) {
      this.contentEl.createEl("p", { text: error instanceof Error ? error.message : t("syncFailed") });
      return;
    }
    if (items.length === 0) {
      this.contentEl.createEl("p", { text: t("trashEmpty") });
      return;
    }
    for (const item of items) {
      const path = await this.label(item);
      new Setting(this.contentEl)
        .setName(path)
        .setDesc(new Date(item.deletedAt).toLocaleString())
        .addButton((button) => {
          button.setButtonText(t("trashRestore")).onClick(() => {
            void this.restore(client, vaultId, item.fileId);
          });
        });
    }
  }

  private async label(item: TrashItem): Promise<string> {
    try {
      const keys = this.plugin.settings.secretKey.trim().length >= 16 && this.plugin.settings.encryptNotes
        ? await deriveKeys(this.plugin.settings.secretKey)
        : null;
      const bytes = await openBytes(keys?.encKey ?? null, item.pathCipher, `path:${item.fileId}`);
      return new TextDecoder().decode(bytes);
    } catch {
      return item.fileId.slice(0, 8);
    }
  }

  private async restore(client: SyncClient, vaultId: string, fileId: string): Promise<void> {
    try {
      await client.restoreTrash(vaultId, fileId);
      new Notice(t("trashRestored"));
      await this.render();
      void this.plugin.syncNow(false);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("syncFailed"));
    }
  }
}
