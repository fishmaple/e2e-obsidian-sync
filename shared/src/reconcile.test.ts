import assert from "node:assert/strict";
import test from "node:test";
import { decideSyncAction } from "./reconcile";

const local = (contentMac: string, encoding: "e2ee" | "plain" = "e2ee") => ({ contentMac, encoding });
const remote = (contentMac: string, rev: number, encoding: "e2ee" | "plain" = "e2ee") => ({ contentMac, rev, encoding });

test("a new local file uploads with no parent", () => {
  assert.deepEqual(decideSyncAction({
    local: local("aa"),
    remote: null,
    base: null,
  }), { type: "upload", parentRev: null });
});

test("matching fingerprints are unchanged, including a revision bump of the same bytes", () => {
  assert.deepEqual(decideSyncAction({
    local: local("aa"),
    remote: remote("aa", 4),
    base: { rev: 2, contentMac: "aa" },
  }), { type: "unchanged" });
});

test("only the local side changed when the remote revision is still the baseline", () => {
  assert.deepEqual(decideSyncAction({
    local: local("bb"),
    remote: remote("aa", 3),
    base: { rev: 3, contentMac: "aa" },
  }), { type: "upload", parentRev: 3 });
});

test("a clean local file downloads a moved remote revision", () => {
  assert.deepEqual(decideSyncAction({
    local: local("aa"),
    remote: remote("bb", 4),
    base: { rev: 3, contentMac: "aa" },
  }), { type: "download" });
});

test("both sides changing is a content conflict", () => {
  assert.deepEqual(decideSyncAction({
    local: local("bb"),
    remote: remote("cc", 5),
    base: { rev: 3, contentMac: "aa" },
  }), { type: "conflict", kind: "content" });
});

test("different bytes and no baseline conflict instead of comparing mtime", () => {
  assert.deepEqual(decideSyncAction({
    local: local("bb"),
    remote: remote("cc", 1),
    base: null,
  }), { type: "conflict", kind: "content" });
});

test("a clean local file is removed when the remote file is gone", () => {
  assert.deepEqual(decideSyncAction({
    local: local("aa"),
    remote: null,
    base: { rev: 2, contentMac: "aa" },
  }), { type: "delete-local" });
});

test("a dirty local file conflicts with a remote delete", () => {
  assert.deepEqual(decideSyncAction({
    local: local("bb"),
    remote: null,
    base: { rev: 2, contentMac: "aa" },
  }), { type: "conflict", kind: "remote-deleted" });
});

test("a local delete is propagated when the remote revision is unchanged", () => {
  assert.deepEqual(decideSyncAction({
    local: null,
    remote: remote("aa", 2),
    base: { rev: 2, contentMac: "aa" },
  }), { type: "delete-remote" });
});

test("a local delete conflicts when the remote revision moved", () => {
  assert.deepEqual(decideSyncAction({
    local: null,
    remote: remote("bb", 6),
    base: { rev: 2, contentMac: "aa" },
  }), { type: "conflict", kind: "local-deleted" });
});

test("an unknown revision falls back to the content fingerprint", () => {
  assert.deepEqual(decideSyncAction({
    local: local("bb"),
    remote: remote("aa", 0),
    base: { contentMac: "aa" },
  }), { type: "upload", parentRev: null });
});

test("the same plaintext with a new encryption flag is uploaded", () => {
  assert.deepEqual(decideSyncAction({
    local: local("aa", "e2ee"),
    remote: remote("aa", 2, "plain"),
    base: { rev: 2, contentMac: "aa" },
  }), { type: "upload", parentRev: 2 });
});
