import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "sync_session";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface SessionBody {
  accountId: string;
  exp: number;
}

export function sessionCookieName(): string {
  return COOKIE;
}

export function sealSession(accountId: string, secret: string): string {
  const body = Buffer.from(JSON.stringify({ accountId, exp: Date.now() + TTL_MS } satisfies SessionBody)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function openSession(token: string, secret: string): string | undefined {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionBody;
    if (!parsed.accountId || parsed.exp < Date.now()) return undefined;
    return parsed.accountId;
  } catch {
    return undefined;
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function setCookieHeader(token: string, secure: boolean): string {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookieHeader(secure: boolean): string {
  const parts = [`${COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
