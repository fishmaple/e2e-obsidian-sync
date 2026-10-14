import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface QiniuConfig {
  accessKey: string;
  secretKey: string;
  bucket: string;
  domain: string;
  uploadUrl: string;
  rsUrl: string;
  privateBucket: boolean;
}

export type DatabaseConfig =
  | { kind: "sqlite"; path: string }
  | { kind: "postgres"; url: string }
  | { kind: "mysql"; url: string };

export type StorageConfig = { kind: "file" } | { kind: "database" } | ({ kind: "qiniu" } & QiniuConfig);

export interface AppConfig {
  port: number;
  dataDir: string;
  sessionSecret: string;
  oidc: OidcConfig | null;
  allowDevLogin: boolean;
  mode: "central" | "single";
  requireEncryption: boolean;
  accessToken: string;
  database: DatabaseConfig;
  storage: StorageConfig;
}

const QINIU_UPLOAD: Record<string, string> = {
  z0: "https://upload.qiniup.com",
  z1: "https://upload-z1.qiniup.com",
  z2: "https://upload-z2.qiniup.com",
  na0: "https://upload-na0.qiniup.com",
  as0: "https://upload-as0.qiniup.com",
  "cn-east-2": "https://upload-cn-east-2.qiniup.com",
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) loadDotEnv();
  const port = Number(env.PORT ?? 8787);
  const dataDir = env.DATA_DIR ?? join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });
  const issuer = env.OIDC_ISSUER?.trim() ?? "";
  const clientId = env.OIDC_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.OIDC_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = env.OIDC_REDIRECT_URI?.trim() ?? "";
  const oidc = issuer && clientId && clientSecret && redirectUri
    ? { issuer, clientId, clientSecret, redirectUri }
    : null;
  const mode = env.SERVER_MODE?.trim() === "single" ? "single" : "central";
  const allowDevLogin = mode === "central" && (env.ALLOW_DEV_LOGIN
    ? env.ALLOW_DEV_LOGIN === "true"
    : !oidc);
  const requireEncryption = env.REQUIRE_ENCRYPTION
    ? env.REQUIRE_ENCRYPTION === "true"
    : mode === "central";
  return {
    port,
    dataDir,
    sessionSecret: env.SESSION_SECRET?.trim() || loadOrCreateSecret(dataDir),
    oidc,
    allowDevLogin,
    mode,
    requireEncryption,
    accessToken: env.ACCESS_TOKEN?.trim() ?? "",
    database: resolveDatabase(env, dataDir),
    storage: resolveStorage(env),
  };
}

export function resolveDatabase(env: NodeJS.ProcessEnv, dataDir: string): DatabaseConfig {
  const url = env.DATABASE_URL?.trim() ?? "";
  if (!url || url === "sqlite" || url === "sqlite:" || url === "sqlite://") {
    return { kind: "sqlite", path: join(dataDir, "sync.db") };
  }
  if (url.startsWith("sqlite:") || url.startsWith("sqlite://")) {
    const raw = url.replace(/^sqlite:\/\//, "").replace(/^sqlite:/, "");
    const path = isAbsolute(raw) ? raw : join(dataDir, raw);
    return { kind: "sqlite", path };
  }
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return { kind: "postgres", url };
  if (url.startsWith("mysql://")) return { kind: "mysql", url };
  throw new Error("DATABASE_URL must be sqlite:, postgres://, postgresql://, or mysql://");
}

export function resolveStorage(env: NodeJS.ProcessEnv): StorageConfig {
  const kind = (env.STORAGE?.trim() || "file").toLowerCase();
  if (kind === "file" || kind === "database") return { kind };
  if (kind !== "qiniu") throw new Error("STORAGE must be file, database, or qiniu");
  const accessKey = env.QINIU_ACCESS_KEY?.trim() ?? "";
  const secretKey = env.QINIU_SECRET_KEY?.trim() ?? "";
  const bucket = env.QINIU_BUCKET?.trim() ?? "";
  const domain = (env.QINIU_DOMAIN?.trim() ?? "").replace(/\/$/, "");
  const zone = env.QINIU_ZONE?.trim() || "z0";
  const uploadUrl = QINIU_UPLOAD[zone];
  if (!accessKey || !secretKey || !bucket || !domain) {
    throw new Error("Qiniu storage requires QINIU_ACCESS_KEY, QINIU_SECRET_KEY, QINIU_BUCKET, and QINIU_DOMAIN");
  }
  if (!uploadUrl) throw new Error(`Unknown Qiniu zone ${zone}. Choices: ${Object.keys(QINIU_UPLOAD).join(", ")}`);
  if (!/^https?:\/\//i.test(domain)) throw new Error("QINIU_DOMAIN must start with http:// or https://");
  return {
    kind: "qiniu",
    accessKey,
    secretKey,
    bucket,
    domain,
    uploadUrl,
    rsUrl: (env.QINIU_RS_URL?.trim() || "https://rs.qiniu.com").replace(/\/$/, ""),
    privateBucket: env.QINIU_PRIVATE !== "false",
  };
}

function loadDotEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of [join(process.cwd(), ".env"), join(here, "..", ".env")]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const eq = trimmed.indexOf("=");
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
}

function loadOrCreateSecret(dataDir: string): string {
  const file = join(dataDir, "session.secret");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Generated on first launch.
  }
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(file, secret, { encoding: "utf8", mode: 0o600 });
  return secret;
}
