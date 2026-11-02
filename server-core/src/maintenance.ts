import type { AppConfig } from "./config";
import type { SyncDb } from "./db";
import { discardUpload } from "./urls";
import type { BlobStore } from "./storage";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function sweepExpiredUploads(config: AppConfig, db: SyncDb): Promise<number> {
  const expired = await db.listExpiredGrants(Date.now());
  for (const item of expired) {
    await discardUpload(config, db, item.accountId, item.fileId);
  }
  return expired.length;
}

export async function sweepTrash(db: SyncDb, blobs: BlobStore): Promise<number> {
  const accounts = await db.listAccountIds();
  let removed = 0;
  for (const accountId of accounts) {
    const policy = await db.accountPolicy(accountId);
    const ids = await db.purgeTrash(accountId, Date.now() - policy.trashDays * DAY_MS, policy.trashMaxFiles);
    for (const fileId of ids) {
      await blobs.delete(accountId, fileId);
      await db.deleteObjectHash(accountId, fileId);
      removed += 1;
    }
  }
  return removed;
}
