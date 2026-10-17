import type { SyncSettings } from "./main";

export function hasActiveBinding(settings: SyncSettings): boolean {
  return Boolean(
    settings.apiToken.trim()
    && settings.accountId.trim()
    && settings.boundVault.trim()
    && settings.boundVaultId.trim()
    && settings.boundAccountId === settings.accountId,
  );
}
