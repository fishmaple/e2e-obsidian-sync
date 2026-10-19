import assert from "node:assert/strict";
import test from "node:test";
import { resolveDatabase, resolveStorage } from "./config";
import { qiniuUploadToken } from "./storage";

test("sqlite is the default and a database url can replace it", () => {
  assert.equal(resolveDatabase({}, "E:/data").kind, "sqlite");
  assert.equal(resolveDatabase({ DATABASE_URL: "postgres://localhost/notes" }, "E:/data").kind, "postgres");
  assert.equal(resolveDatabase({ DATABASE_URL: "mysql://localhost/notes" }, "E:/data").kind, "mysql");
  assert.throws(() => resolveDatabase({ DATABASE_URL: "mongodb://localhost" }, "E:/data"));
});

test("storage can be local files, the database, or qiniu", () => {
  assert.equal(resolveStorage({}).kind, "file");
  assert.equal(resolveStorage({ STORAGE: "database" }).kind, "database");
  const qiniu = resolveStorage({
    STORAGE: "qiniu",
    QINIU_ACCESS_KEY: "access",
    QINIU_SECRET_KEY: "secret",
    QINIU_BUCKET: "vault",
    QINIU_DOMAIN: "https://cdn.example.com/",
    QINIU_ZONE: "z0",
  });
  assert.equal(qiniu.kind, "qiniu");
  if (qiniu.kind !== "qiniu") return;
  assert.equal(qiniu.domain, "https://cdn.example.com");
  assert.equal(qiniu.privateBucket, true);
  const token = qiniuUploadToken(qiniu, "vaults/a/b");
  assert.equal(token.split(":").length, 3);
  assert.ok(token.startsWith("access:"));
});
