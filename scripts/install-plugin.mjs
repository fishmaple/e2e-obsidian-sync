import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const vault = process.argv[2];
if (!vault) {
  console.error("Usage: npm run plugin:install -- <obsidian-vault-path>");
  process.exit(1);
}

const source = "plugin";
if (!existsSync(join(source, "main.js"))) {
  console.error("The plugin is not built. Run npm run plugin:build first.");
  process.exit(1);
}

const dest = join(vault, ".obsidian", "plugins", "e2ee-sync");
mkdirSync(dest, { recursive: true });
for (const file of ["manifest.json", "main.js", "styles.css"]) {
  copyFileSync(join(source, file), join(dest, file));
}
console.log(`Copied to ${dest}`);
console.log("Enable End-to-end encrypted sync in Obsidian, or reload the plugin.");
