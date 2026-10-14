let warnedMissing = false;

export function isDesktopApp(): boolean {
  const proc = (globalThis as { process?: { versions?: { electron?: string } } }).process;
  return Boolean(proc?.versions?.electron);
}

export function warnMissingObsidianConfig(): void {
  if (warnedMissing) return;
  warnedMissing = true;
  console.warn("Obsidian's config folder was not found. The account and key will not be shared across vaults.");
}

export function obsidianConfigDir(): string | null {
  if (!isDesktopApp()) return null;
  try {
    const fs = require("fs") as { existsSync: (target: string) => boolean };
    const path = require("path") as { join: (...parts: string[]) => string };
    const userData = electronUserData();
    if (userData && fs.existsSync(path.join(userData, "obsidian.json"))) return userData;
    const os = require("os") as { homedir: () => string };
    const env = (globalThis as {
      process?: { platform?: string; env?: Record<string, string | undefined> };
    }).process;
    const home = os.homedir();
    const platform = env?.platform ?? "";
    const candidates: string[] = [];
    if (platform === "win32") {
      if (env?.env?.APPDATA) candidates.push(path.join(env.env.APPDATA, "obsidian"));
    } else if (platform === "darwin") {
      candidates.push(path.join(home, "Library", "Application Support", "obsidian"));
    } else {
      const xdg = env?.env?.XDG_CONFIG_HOME;
      candidates.push(path.join(xdg || path.join(home, ".config"), "obsidian"));
      candidates.push(path.join(home, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian"));
      candidates.push(path.join(home, "snap", "obsidian", "current", ".config", "obsidian"));
    }
    return candidates.find((dir) => fs.existsSync(path.join(dir, "obsidian.json"))) ?? null;
  } catch (error) {
    console.warn("Could not read Obsidian's config folder", error);
    return null;
  }
}

function electronUserData(): string {
  try {
    const electron = require("electron") as {
      app?: { getPath?: (name: string) => string };
      remote?: { app?: { getPath?: (name: string) => string } };
    };
    const getPath = electron.remote?.app?.getPath ?? electron.app?.getPath;
    return getPath ? getPath("userData") : "";
  } catch {
    return "";
  }
}

declare function require(moduleName: string): unknown;
