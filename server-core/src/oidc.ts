import { createRemoteJWKSet, jwtVerify } from "jose";
import { bytesToBase64Url, randomBytes } from "../../shared/src/codec";
import type { OidcConfig } from "./config";

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const discoveryCache = new Map<string, Discovery>();

export async function createOidcRequest(config: OidcConfig): Promise<{
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}> {
  const discovery = await loadDiscovery(config.issuer);
  const state = token();
  const nonce = token();
  const codeVerifier = token();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const challenge = bytesToBase64Url(new Uint8Array(digest));
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), state, nonce, codeVerifier };
}

export async function completeOidcLogin(config: OidcConfig, code: string, codeVerifier: string, nonce: string): Promise<{
  subject: string;
  displayName: string;
}> {
  const discovery = await loadDiscovery(config.issuer);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: codeVerifier,
  });
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await response.json() as { id_token?: string; error?: string; error_description?: string };
  if (!response.ok || !json.id_token) {
    throw new Error(json.error_description || json.error || "SSO token exchange failed");
  }
  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  const { payload } = await jwtVerify(json.id_token, jwks, {
    issuer: discovery.issuer,
    audience: config.clientId,
  });
  if (payload.nonce !== nonce) throw new Error("SSO nonce does not match");
  if (!payload.sub || !payload.iss) throw new Error("SSO identity is missing sub");
  const display = [payload.name, payload.preferred_username, payload.email, payload.sub].find((item) => typeof item === "string") as string;
  return { subject: `oidc:${payload.iss}|${payload.sub}`, displayName: display };
}

async function loadDiscovery(issuer: string): Promise<Discovery> {
  const cached = discoveryCache.get(issuer);
  if (cached) return cached;
  const response = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`Could not read the SSO configuration (${response.status})`);
  const json = await response.json() as Partial<Discovery>;
  if (!json.issuer || !json.authorization_endpoint || !json.token_endpoint || !json.jwks_uri) {
    throw new Error("SSO configuration is incomplete");
  }
  const discovery: Discovery = {
    issuer: json.issuer,
    authorization_endpoint: json.authorization_endpoint,
    token_endpoint: json.token_endpoint,
    jwks_uri: json.jwks_uri,
  };
  discoveryCache.set(issuer, discovery);
  return discovery;
}

function token(): string {
  return bytesToBase64Url(randomBytes(32));
}
