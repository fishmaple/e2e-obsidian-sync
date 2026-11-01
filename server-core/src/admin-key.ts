import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function loadOrCreateAdminKey(dataDir: string, fromEnv: string): { key: string; created: boolean } {
  const configured = fromEnv.trim();
  if (configured) return { key: configured, created: false };
  const path = join(dataDir, "admin.key");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return { key: existing, created: false };
  } catch {
    // First boot writes the key below.
  }
  const key = randomBytes(24).toString("base64url");
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  return { key, created: true };
}
