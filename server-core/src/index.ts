import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadOrCreateAdminKey } from "./admin-key";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { migrateBlobLayout } from "./migrate";
import { sweepExpiredUploads, sweepTrash } from "./maintenance";
import { hashPassword, randomPassword } from "./passwords";
import { createBlobStore, prepareStorage } from "./storage";

const config = await prepareStorage(loadConfig());
const admin = loadOrCreateAdminKey(config.dataDir, config.adminKey);
config.adminKey = admin.key;
const db = await openDatabase(config);
const moved = await migrateBlobLayout(config, db);
const blobs = createBlobStore(config, db);
const app = createApp({ config, db });

if (admin.created) console.log(`Admin key: ${admin.key}`);
if ((await db.countAccounts()) === 0 && (await db.countLogins()) === 0) {
  const password = randomPassword();
  const hashed = await hashPassword(password);
  const account = await db.upsertAccount("login:owner", "owner");
  await db.insertLogin("owner", account.id, hashed.hash, hashed.salt);
  console.log("Initial login id: owner");
  console.log(`Initial password: ${password}`);
}

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

const sweep = () => {
  void sweepExpiredUploads(config, db).catch((error) => console.error("Upload cleanup failed", error));
  void sweepTrash(db, blobs).catch((error) => console.error("Trash cleanup failed", error));
};
sweep();
const sweepTimer = setInterval(sweep, 10 * 60 * 1000);
sweepTimer.unref?.();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void db.close().finally(() => process.exit(0));
  });
}
