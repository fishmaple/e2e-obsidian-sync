import assert from "node:assert/strict";
import test from "node:test";
import {
  applySharedConfig,
  mergeSharedConfig,
  sharedLoginKind,
  shouldAdoptSharedLogin,
  vaultHasLogin,
  type SharedSyncConfig,
} from "./src/shared-config";

function login(partial: Partial<SharedSyncConfig> = {}): SharedSyncConfig {
  return {
    host: "",
    accountId: "",
    displayName: "",
    apiToken: "",
    secretKey: "",
    accessToken: "",
    encryptNotes: false,
    ...partial,
  };
}

const vaultA = login({
  host: "https://a.example",
  accountId: "alice",
  displayName: "Alice",
  apiToken: "token-a",
  secretKey: "secret-a-secret-a",
  accessToken: "access-a",
});

const vaultB = login({
  host: "https://b.example",
  accountId: "bob",
  displayName: "Bob",
  apiToken: "token-b",
  secretKey: "secret-b-secret-b",
  accessToken: "access-b",
});

test("a vault login is an account id or an api token", () => {
  assert.equal(vaultHasLogin(login()), false);
  assert.equal(vaultHasLogin(login({ accountId: "  " })), false);
  assert.equal(vaultHasLogin(login({ accountId: "alice" })), true);
  assert.equal(vaultHasLogin(login({ apiToken: "token-a" })), true);
  assert.equal(vaultHasLogin(null), false);
});

test("shared login fills an empty vault and leaves a configured vault alone", () => {
  const fresh = applySharedConfig(login(), vaultA);
  assert.equal(fresh.host, vaultA.host);
  assert.equal(fresh.accountId, "alice");
  assert.equal(fresh.apiToken, "token-a");
  assert.equal(fresh.secretKey, vaultA.secretKey);
  assert.equal(fresh.accessToken, "access-a");
  assert.equal(fresh.displayName, "Alice");

  const configured = applySharedConfig(login({ ...vaultB }), vaultA);
  assert.equal(configured.host, vaultB.host);
  assert.equal(configured.accountId, "bob");
  assert.equal(configured.apiToken, "token-b");
  assert.equal(configured.secretKey, vaultB.secretKey);
  assert.equal(configured.accessToken, "access-b");
  assert.equal(configured.displayName, "Bob");
});

test("a configured vault keeps an empty host and its own secret", () => {
  const configured = applySharedConfig(login({ ...vaultB, host: "", secretKey: "" }), vaultA);
  assert.equal(configured.host, "");
  assert.equal(configured.accountId, "bob");
  assert.equal(configured.apiToken, "token-b");
  assert.equal(configured.secretKey, "");
  assert.equal(configured.accessToken, "access-b");
});

test("applyLogin false does not copy credentials back onto a logged-out vault", () => {
  const loggedOut = applySharedConfig(login({ host: "https://b.example" }), vaultA, { applyLogin: false });
  assert.equal(loggedOut.host, "https://b.example");
  assert.equal(loggedOut.accountId, "");
  assert.equal(loggedOut.apiToken, "");
  assert.equal(loggedOut.secretKey, "");
});

test("seed writes the first login and host, then refuses to replace either", () => {
  assert.deepEqual(mergeSharedConfig(null, login(), "seed"), null);
  assert.deepEqual(mergeSharedConfig(null, vaultA, "seed"), login({ ...vaultA, encryptNotes: false }));

  assert.equal(mergeSharedConfig(vaultA, vaultB, "seed"), null);
  assert.equal(mergeSharedConfig(login({ ...vaultA, host: "" }), vaultB, "seed"), null);
  assert.equal(mergeSharedConfig(vaultA, login({ host: "https://b.example" }), "seed"), null);
});

test("replace copies this vault's login and keeps a shared host when this vault has none", () => {
  const replaced = mergeSharedConfig(vaultA, vaultB, "replace");
  assert.equal(replaced?.accountId, "bob");
  assert.equal(replaced?.apiToken, "token-b");
  assert.equal(replaced?.secretKey, vaultB.secretKey);
  assert.equal(replaced?.host, vaultB.host);

  const keepHost = mergeSharedConfig(vaultA, login({ ...vaultB, host: "" }), "replace");
  assert.equal(keepHost?.host, vaultA.host);
  assert.equal(keepHost?.apiToken, "token-b");
  assert.equal(mergeSharedConfig(vaultA, login(), "replace"), null);
});

test("shared login is adopted only on a vault that has never stored one", () => {
  assert.equal(shouldAdoptSharedLogin({ hasLogin: false, skipSharedLogin: false, storedHadLoginField: false }), true);
  assert.equal(shouldAdoptSharedLogin({ hasLogin: true, skipSharedLogin: false, storedHadLoginField: false }), false);
  assert.equal(shouldAdoptSharedLogin({ hasLogin: false, skipSharedLogin: true, storedHadLoginField: false }), false);
  assert.equal(shouldAdoptSharedLogin({ hasLogin: false, skipSharedLogin: false, storedHadLoginField: true }), false);
});

test("shared login kind tells the settings row which action is safe", () => {
  assert.equal(sharedLoginKind(login(), null, false), "unavailable");
  assert.equal(sharedLoginKind(login(), null, true), "both-empty");
  assert.equal(sharedLoginKind(login(), vaultA, true), "logged-out");
  assert.equal(sharedLoginKind(vaultA, null, true), "shared-empty");
  assert.equal(sharedLoginKind(vaultA, vaultA, true), "matches");
  assert.equal(sharedLoginKind(vaultB, vaultA, true), "differs");
  assert.equal(sharedLoginKind(login({ ...vaultA, secretKey: "other-secret-key" }), vaultA, true), "differs");
});
