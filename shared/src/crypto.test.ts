import assert from "node:assert/strict";
import test from "node:test";
import { randomSecret } from "./codec";
import { contentMac, decryptBytes, deriveKeys, encryptBytes, fileIdForPath, signRequest, verifySignature } from "./crypto";
import { MIN_SECRET_LENGTH } from "./protocol";

test("a random key encrypts and decrypts, and the wrong key fails", async () => {
  const secret = randomSecret();
  assert.ok(secret.length >= MIN_SECRET_LENGTH);
  const keys = await deriveKeys(secret);
  const fileId = await fileIdForPath(keys.idKey, "日记/今天.md");
  const plain = new TextEncoder().encode("你好，端到端");
  const envelope = await encryptBytes(keys.encKey, plain, `body:${fileId}`);
  const back = await decryptBytes(keys.encKey, envelope, `body:${fileId}`);
  assert.equal(new TextDecoder().decode(back), "你好，端到端");

  const other = await deriveKeys(randomSecret());
  await assert.rejects(() => decryptBytes(other.encKey, envelope, `body:${fileId}`));
  await assert.rejects(() => decryptBytes(keys.encKey, envelope, `body:other`));
});

test("a path keeps a stable file id and the auth signature verifies", async () => {
  const keys = await deriveKeys("this-is-a-long-secret");
  const again = await deriveKeys("this-is-a-long-secret");
  const path = "文件夹/笔记.md";
  assert.equal(await fileIdForPath(keys.idKey, path), await fileIdForPath(again.idKey, path));
  assert.equal(await contentMac(keys.idKey, new Uint8Array([1, 2, 3])), await contentMac(again.idKey, new Uint8Array([1, 2, 3])));

  const body = new TextEncoder().encode(JSON.stringify({ ok: true }));
  const headers = await signRequest(keys.authKey, {
    method: "PUT",
    path: "/api/v1/objects/abc",
    body,
    accountId: "acc",
    timestamp: "1000",
  });
  const ok = await verifySignature(keys.authKeyRaw, {
    method: "put",
    path: "/api/v1/objects/abc",
    body,
    timestamp: "1000",
    signatureHex: headers["x-signature"],
  });
  assert.equal(ok, true);
  const bad = await verifySignature(again.authKeyRaw, {
    method: "PUT",
    path: "/api/v1/objects/other",
    body,
    timestamp: "1000",
    signatureHex: headers["x-signature"],
  });
  assert.equal(bad, false);
});
