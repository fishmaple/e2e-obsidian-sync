import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const configPath = join(process.env.APPDATA ?? "", "obsidian", "obsidian.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const source = join("plugin");
for (const vault of Object.values(config.vaults ?? {})) {
  const root = vault.path;
  const dest = join(root, ".obsidian", "plugins", "e2ee-sync");
  mkdirSync(dest, { recursive: true });
  for (const file of ["manifest.json", "main.js", "styles.css"]) {
    copyFileSync(join(source, file), join(dest, file));
  }
  const listPath = join(root, ".obsidian", "community-plugins.json");
  let list = [];
  if (existsSync(listPath)) {
    const parsed = JSON.parse(readFileSync(listPath, "utf8"));
    if (Array.isArray(parsed)) list = parsed;
  }
  if (!list.includes("e2ee-sync")) list.push("e2ee-sync");
  writeFileSync(listPath, JSON.stringify(list, null, 2));
  console.log(root);
}
