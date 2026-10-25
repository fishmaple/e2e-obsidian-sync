import type { Encoding } from "./protocol";

export interface SyncBase {
  rev?: number;
  contentMac: string;
}

export interface SyncSide {
  contentMac: string;
  encoding: Encoding;
}

export interface SyncRemote extends SyncSide {
  rev: number;
}

export type SyncAction =
  | { type: "unchanged" }
  | { type: "upload"; parentRev: number | null }
  | { type: "download" }
  | { type: "delete-local" }
  | { type: "delete-remote" }
  | { type: "conflict"; kind: "content" | "remote-deleted" | "local-deleted" };

/**
 * Git-style decision from a local byte fingerprint, the current remote
 * metadata, and the last synced baseline. Modification time is not used.
 */
export function decideSyncAction(input: {
  local: SyncSide | null;
  remote: SyncRemote | null;
  base: SyncBase | null;
}): SyncAction {
  const { local, remote, base } = input;
  if (local && remote) {
    if (local.contentMac === remote.contentMac) {
      if (local.encoding === remote.encoding) return { type: "unchanged" };
      return { type: "upload", parentRev: parentOf(remote) };
    }
    if (!base) return { type: "conflict", kind: "content" };
    const localClean = base.contentMac === local.contentMac;
    if (localClean) return { type: "download" };
    if (!remoteHasMoved(base, remote)) return { type: "upload", parentRev: parentOf(remote) };
    return { type: "conflict", kind: "content" };
  }
  if (local && !remote) {
    if (!base) return { type: "upload", parentRev: null };
    if (base.contentMac === local.contentMac) return { type: "delete-local" };
    return { type: "conflict", kind: "remote-deleted" };
  }
  if (!local && remote) {
    if (!base) return { type: "download" };
    if (!remoteHasMoved(base, remote)) return { type: "delete-remote" };
    return { type: "conflict", kind: "local-deleted" };
  }
  return { type: "unchanged" };
}

function remoteHasMoved(base: SyncBase, remote: SyncRemote): boolean {
  if (typeof base.rev === "number" && base.rev > 0 && remote.rev > 0) return base.rev !== remote.rev;
  return base.contentMac !== remote.contentMac;
}

function parentOf(remote: SyncRemote): number | null {
  return remote.rev > 0 ? remote.rev : null;
}
