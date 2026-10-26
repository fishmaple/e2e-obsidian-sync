import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { migrateBlobLayout } from "./migrate";
import { prepareStorage } from "./storage";

const config = await prepareStorage(loadConfig());
const db = await openDatabase(config);
const moved = await migrateBlobLayout(config, db);
const app = createApp({ config, db });

if (config.mode === "single") {
  const account = await db.ensureSingleAccount();
  console.log(`Single-account mode. Issued account ID: ${account.id}`);
} else {
  console.log("Central mode. Users receive an account ID after login.");
}
const inline = config.storage.kind === "r2" ? `, inline under ${config.storage.inlineMaxBytes} bytes` : "";
console.log(`Database: ${config.database.kind}, storage: ${config.storage.kind}${inline}, moved ${moved} blobs, ${config.requireEncryption ? "encryption required" : "plaintext allowed"}`);

serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  const shown = info.address === "0.0.0.0" ? "127.0.0.1" : info.address;
  console.log(`Sync server listening at http://${shown}:${info.port}`);
  if (config.oidc) console.log("SSO is enabled");
  if (config.allowDevLogin) console.log("Developer login is enabled");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void db.close().finally(() => process.exit(0));
  });
}
