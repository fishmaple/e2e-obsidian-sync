import { createHash, createHmac } from "node:crypto";
import type { R2Config } from "./config";

export interface R2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface R2ObjectRef {
  accountId: string;
  fileId: string;
  size: number;
}

function blobKey(accountId: string, fileId: string): string {
  return `vaults/${accountId}/${fileId}`;
}

function stagingKey(accountId: string, fileId: string): string {
  return `${blobKey(accountId, fileId)}.upload`;
}

const ACCOUNT_ID = /^[0-9a-f-]{36}$/i;
const FILE_ID = /^[0-9a-f]{64}$/;

export async function credentialsFromApiToken(token: string): Promise<R2Credentials> {
  const response = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json() as { success?: boolean; result?: { id?: string; status?: string } };
  const accessKeyId = body.result?.id?.trim() ?? "";
  if (!response.ok || !body.success || !accessKeyId || body.result?.status !== "active") {
    throw new Error("Cloudflare rejected the R2 API token");
  }
  return {
    accessKeyId,
    secretAccessKey: createHash("sha256").update(token).digest("hex"),
  };
}

export async function resolveR2Credentials(config: R2Config): Promise<R2Credentials> {
  if (config.accessKeyId && config.secretAccessKey) {
    return { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
  }
  if (!config.apiToken) {
    throw new Error("R2 storage requires R2_API_TOKEN or both R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY");
  }
  return credentialsFromApiToken(config.apiToken);
}

export class R2Client {
  constructor(
    private readonly endpoint: string,
    private readonly bucket: string,
    private readonly credentials: R2Credentials,
  ) {}

  async put(accountId: string, fileId: string, json: string): Promise<void> {
    const body = Buffer.from(json, "utf8");
    const response = await this.request("PUT", blobKey(accountId, fileId), undefined, body);
    if (!response.ok) throw new Error(`R2 upload failed (${response.status})`);
  }

  async get(accountId: string, fileId: string): Promise<string> {
    const response = await this.request("GET", blobKey(accountId, fileId));
    if (response.status === 404) throw new Error("The object store has no content for this file");
    if (!response.ok) throw new Error(`R2 read failed (${response.status})`);
    return new TextDecoder().decode(response.body);
  }

  async delete(accountId: string, fileId: string): Promise<void> {
    await this.deleteKey(blobKey(accountId, fileId));
  }

  presignDownload(accountId: string, fileId: string, expiresSeconds: number): string {
    return presignR2Url({
      method: "GET",
      endpoint: this.endpoint,
      bucket: this.bucket,
      key: blobKey(accountId, fileId),
      accessKeyId: this.credentials.accessKeyId,
      secretAccessKey: this.credentials.secretAccessKey,
      expiresSeconds,
    });
  }

  presignUpload(accountId: string, fileId: string, expiresSeconds: number): string {
    return presignR2Url({
      method: "PUT",
      endpoint: this.endpoint,
      bucket: this.bucket,
      key: stagingKey(accountId, fileId),
      accessKeyId: this.credentials.accessKeyId,
      secretAccessKey: this.credentials.secretAccessKey,
      expiresSeconds,
    });
  }

  async stagingSize(accountId: string, fileId: string): Promise<number | undefined> {
    const signed = signR2Request({
      method: "HEAD",
      endpoint: this.endpoint,
      bucket: this.bucket,
      key: stagingKey(accountId, fileId),
      accessKeyId: this.credentials.accessKeyId,
      secretAccessKey: this.credentials.secretAccessKey,
    });
    const response = await fetch(signed.url, {
      method: "HEAD",
      headers: signed.headers,
      signal: AbortSignal.timeout(120000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`R2 head failed (${response.status})`);
    const length = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("R2 head did not return a size");
    return length;
  }

  async copyStaging(accountId: string, fileId: string): Promise<void> {
    const source = `/${this.bucket}/${stagingKey(accountId, fileId).split("/").map(encodeRfc3986).join("/")}`;
    const signed = signR2Request({
      method: "PUT",
      endpoint: this.endpoint,
      bucket: this.bucket,
      key: blobKey(accountId, fileId),
      body: Buffer.alloc(0),
      headers: { "x-amz-copy-source": source },
      accessKeyId: this.credentials.accessKeyId,
      secretAccessKey: this.credentials.secretAccessKey,
    });
    const response = await fetch(signed.url, {
      method: "PUT",
      headers: signed.headers,
      body: new Uint8Array(0),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`R2 copy failed (${response.status})`);
  }

  async deleteStaging(accountId: string, fileId: string): Promise<void> {
    await this.deleteKey(stagingKey(accountId, fileId));
  }

  private async deleteKey(key: string): Promise<void> {
    const response = await this.request("DELETE", key);
    if (!response.ok && response.status !== 404) throw new Error(`R2 delete failed (${response.status})`);
  }

  async list(): Promise<R2ObjectRef[]> {
    const found: R2ObjectRef[] = [];
    let token = "";
    for (let page = 0; page < 10000; page++) {
      const query: Record<string, string> = { "list-type": "2", prefix: "vaults/" };
      if (token) query["continuation-token"] = token;
      const response = await this.request("GET", "", query);
      if (!response.ok) throw new Error(`R2 list failed (${response.status})`);
      const xml = new TextDecoder().decode(response.body);
      const parsed = parseListObjects(xml);
      for (const item of parsed.keys) {
        const ref = parseObjectKey(item.key);
        if (ref) found.push({ ...ref, size: item.size });
      }
      if (!parsed.truncated || !parsed.token) return found;
      token = parsed.token;
    }
    throw new Error("R2 list did not finish");
  }

  private async request(method: string, key: string, query?: Record<string, string>, body?: Buffer): Promise<{ ok: boolean; status: number; body: Uint8Array }> {
    const signed = signR2Request({
      method,
      endpoint: this.endpoint,
      bucket: this.bucket,
      key,
      query,
      body,
      accessKeyId: this.credentials.accessKeyId,
      secretAccessKey: this.credentials.secretAccessKey,
    });
    const response = await fetch(signed.url, {
      method,
      headers: signed.headers,
      body: body ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(120000),
    });
    return { ok: response.ok, status: response.status, body: new Uint8Array(await response.arrayBuffer()) };
  }
}

export function signR2Request(input: {
  method: string;
  endpoint: string;
  bucket: string;
  key?: string;
  query?: Record<string, string>;
  body?: Buffer;
  headers?: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  now?: Date;
}): { url: string; headers: Record<string, string> } {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const payload = input.body ?? Buffer.alloc(0);
  const payloadHash = sha256(payload);
  const host = new URL(input.endpoint).host;
  const canonicalUri = objectUri(input.bucket, input.key);
  const canonicalQuery = canonicalQueryString(input.query ?? {});
  const signed: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    signed[name.toLowerCase()] = value.trim();
  }
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((name) => `${name}:${signed[name]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const signature = createHmac("sha256", signingKey(input.secretAccessKey, dateStamp)).update(stringToSign).digest("hex");
  const url = `${input.endpoint.replace(/\/$/, "")}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  const headers: Record<string, string> = {
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  for (const name of names) headers[name] = signed[name] ?? "";
  return { url, headers };
}

export function presignR2Url(input: {
  method: "GET" | "PUT" | "DELETE";
  endpoint: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(input.endpoint).host;
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalUri = objectUri(input.bucket, input.key);
  const canonicalQuery = canonicalQueryString(query);
  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const signature = createHmac("sha256", signingKey(input.secretAccessKey, dateStamp)).update(stringToSign).digest("hex");
  return `${input.endpoint.replace(/\/$/, "")}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export function parseObjectKey(key: string): { accountId: string; fileId: string } | undefined {
  const parts = key.split("/");
  if (parts.length !== 3 || parts[0] !== "vaults") return undefined;
  if (!ACCOUNT_ID.test(parts[1]) || !FILE_ID.test(parts[2])) return undefined;
  return { accountId: parts[1], fileId: parts[2] };
}

export function parseListObjects(xml: string): { keys: { key: string; size: number }[]; truncated: boolean; token: string } {
  const keys: { key: string; size: number }[] = [];
  for (const block of xml.split("<Contents>").slice(1)) {
    const key = decodeXml(tagText(block, "Key"));
    const size = Number(tagText(block, "Size"));
    if (key) keys.push({ key, size: Number.isFinite(size) ? size : 0 });
  }
  return {
    keys,
    truncated: tagText(xml, "IsTruncated") === "true",
    token: decodeXml(tagText(xml, "NextContinuationToken")),
  };
}

function signingKey(secret: string, dateStamp: string): Buffer {
  const date = createHmac("sha256", `AWS4${secret}`).update(dateStamp).digest();
  const region = createHmac("sha256", date).update("auto").digest();
  const service = createHmac("sha256", region).update("s3").digest();
  return createHmac("sha256", service).update("aws4_request").digest();
}

function objectUri(bucket: string, key?: string): string {
  const prefix = `/${encodeRfc3986(bucket)}`;
  if (!key) return prefix;
  return `${prefix}/${key.split("/").map(encodeRfc3986).join("/")}`;
}

function canonicalQueryString(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(query[key] ?? "")}`)
    .join("&");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function tagText(xml: string, tag: string): string {
  const found = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return found?.[1] ?? "";
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
