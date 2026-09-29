import express from "express";
import type { Request, Response, NextFunction } from "express";
import { randomBytes, createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  createOAuthMetadata,
  mcpAuthRouter,
  TemporarilyUnavailableError,
  type AuthorizationParams,
  type OAuthRegisteredClientsStore,
  type OAuthServerProvider,
} from "@modelcontextprotocol/server-legacy/auth";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthClientInformationFull,
  type OAuthMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/server";
import { config } from "./config.js";
import {
  buildAuthUrl,
  disconnectAndDeleteData,
  exchangeCodeForTokens,
  getTokens,
} from "./whoop/auth.js";
import { getDb } from "./db/connection.js";

// --- Whoop OAuth state store ---
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_AUTH = 100;

// Pending MCP auth params stored while user completes Whoop OAuth
interface PendingMcpAuth {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  issuer: string;
  scopes: string[];
  resource: string;
  resourceWasExplicit: boolean;
  createdAt: number;
}
const pendingMcpAuth = new Map<string, PendingMcpAuth>();

// Pending authorizations awaiting the resource owner's password (consent gate).
// Keyed by a random consentId; single-use, 10-min TTL (STATE_TTL_MS).
interface PendingConsent {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  issuer: string;
  scopes: string[];
  resource: string;
  resourceWasExplicit: boolean;
  createdAt: number;
}
const pendingConsent = new Map<string, PendingConsent>();

function isFresh(createdAt: number, ttlMs = STATE_TTL_MS): boolean {
  return Date.now() - createdAt <= ttlMs;
}

function takeFresh<T extends { createdAt: number }>(map: Map<string, T>, key: string): T | undefined {
  const value = map.get(key);
  if (value) map.delete(key);
  return value && isFresh(value.createdAt) ? value : undefined;
}

function takeFreshTimestamp(map: Map<string, number>, key: string): boolean {
  const createdAt = map.get(key);
  if (createdAt !== undefined) map.delete(key);
  return createdAt !== undefined && isFresh(createdAt);
}

function cleanupStates(): void {
  const now = Date.now();
  for (const [state, created] of pendingStates) {
    if (now - created > STATE_TTL_MS) pendingStates.delete(state);
  }
  for (const [state, data] of pendingMcpAuth) {
    if (now - data.createdAt > STATE_TTL_MS) pendingMcpAuth.delete(state);
  }
  for (const [id, data] of pendingConsent) {
    if (now - data.createdAt > STATE_TTL_MS) pendingConsent.delete(id);
  }
  for (const [code, data] of authorizationCodes) {
    if (now - data.createdAt > AUTH_CODE_TTL_MS) authorizationCodes.delete(code);
  }
}

// sha256 hex — used to store MCP tokens at rest so a DB leak yields no live credentials.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Constant-time comparison for high-entropy bearer tokens. SHA-256 is suitable
// here because these are random machine credentials, not human passwords.
function bearerTokensMatch(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest()
  );
}

// Build a verifier once per app so the configured password is scrypt-derived
// once, while every submitted password still pays the password-KDF cost. The
// random in-memory salt changes on restart and is never persisted or exposed.
function createPasswordVerifier(expected: string): (candidate: string) => boolean {
  const salt = randomBytes(16);
  const expectedDigest = scryptSync(expected, salt, 32);
  const expectedByteLength = Buffer.byteLength(expected);
  return (candidate: string): boolean => {
    const candidateDigest = scryptSync(candidate, salt, 32);
    return timingSafeEqual(candidateDigest, expectedDigest) &&
      Buffer.byteLength(candidate) === expectedByteLength;
  };
}

// --- Password-endpoint rate limiting (dependency-free, in-memory, per-IP) ---
// Throttles brute-force password guessing on POST /auth/consent, /auth/whoop,
// and the owner-confirmed /auth/disconnect operation.
// After MAX_PW_ATTEMPTS failures from one IP within PW_WINDOW_MS the IP is locked
// out (429 + Retry-After) until the window elapses; a correct password resets it.
const PW_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_PW_ATTEMPTS = 5;
const MAX_RATE_LIMIT_KEYS = 1_000;
const pwAttempts = new Map<string, { count: number; first: number }>();

function prunePasswordAttempts(): void {
  const now = Date.now();
  for (const [ip, record] of pwAttempts) {
    if (now - record.first > PW_WINDOW_MS) pwAttempts.delete(ip);
  }
  while (pwAttempts.size >= MAX_RATE_LIMIT_KEYS) {
    const oldest = pwAttempts.keys().next().value as string | undefined;
    if (!oldest) break;
    pwAttempts.delete(oldest);
  }
}

// Seconds to wait if the IP is currently locked out, else 0 (also expires stale windows).
function pwLockoutRetryAfter(ip: string): number {
  const rec = pwAttempts.get(ip);
  if (!rec) return 0;
  if (Date.now() - rec.first > PW_WINDOW_MS) {
    pwAttempts.delete(ip);
    return 0;
  }
  if (rec.count >= MAX_PW_ATTEMPTS) {
    return Math.ceil((PW_WINDOW_MS - (Date.now() - rec.first)) / 1000);
  }
  return 0;
}

function recordPwFailure(ip: string): void {
  prunePasswordAttempts();
  const now = Date.now();
  const rec = pwAttempts.get(ip);
  if (!rec || now - rec.first > PW_WINDOW_MS) {
    pwAttempts.set(ip, { count: 1, first: now });
  } else {
    rec.count += 1;
  }
}

function resetPwAttempts(ip: string): void {
  pwAttempts.delete(ip);
}

// Returns true and sends a 429 (with Retry-After) if the IP is locked out.
function rejectIfRateLimited(req: Request, res: Response): boolean {
  const ip = req.ip ?? "unknown";
  const retryAfter = pwLockoutRetryAfter(ip);
  if (retryAfter > 0) {
    console.error(`[auth] password attempt RATE-LIMITED for ip (retry in ${retryAfter}s)`);
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).send("Too many password attempts. Please try again later.");
    return true;
  }
  return false;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setSensitivePageHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname.toLowerCase());
}

// Redirect-URI allowlist (consent-gate phishing mitigation). A remote redirect
// target must be https AND have a hostname that EXACTLY equals an allowed host
// (config.security.allowedRedirectHosts) — no suffix/substring matching, so
// suffix-confusion hosts are rejected. IPv4 and IPv6 loopback hosts stay
// allowed (http included) for an on-device client.
function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.hash) return false;
  const host = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    isLoopbackHostname(host)
  ) {
    return true;
  }
  return parsed.protocol === "https:" && config.security.allowedRedirectHosts.includes(host);
}

// --- MCP OAuth: short-lived state in-memory, persistent state in SQLite ---
export const MCP_REQUIRED_SCOPES = ["mcp:read"] as const;
const authorizationCodes = new Map<string, Omit<PendingMcpAuth, "state">>();
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const ACCESS_TOKEN_TTL_S = 3600; // 1 hour
const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600; // 30 days

function canonicalMcpResource(): string {
  return new URL("/mcp", config.server.publicUrl).href;
}

function resolveMcpScopes(scopes: string[] | undefined): string[] {
  const requested = [...new Set((scopes ?? []).filter(Boolean))];
  if (requested.some((scope) => !MCP_REQUIRED_SCOPES.includes(scope as (typeof MCP_REQUIRED_SCOPES)[number]))) {
    throw new InvalidScopeError("Only the mcp:read scope is supported");
  }
  // Older MCP clients omitted scope. Grant the deployment's one minimal,
  // read-only scope so their tokens remain compatible with the v2 RS gate.
  return [...MCP_REQUIRED_SCOPES];
}

function resolveMcpResource(resource: URL | undefined): {
  resource: string;
  resourceWasExplicit: boolean;
} {
  const canonical = canonicalMcpResource();
  if (!resource) return { resource: canonical, resourceWasExplicit: false };
  if (resource.username || resource.password || resource.search || resource.hash || resource.href !== canonical) {
    throw new InvalidTargetError("The resource must exactly identify this deployment's /mcp endpoint");
  }
  return { resource: canonical, resourceWasExplicit: true };
}

function validateTokenResource(
  resource: URL | undefined,
  expected: string,
  wasExplicit: boolean,
): void {
  // A resource supplied on the authorization request must be repeated at the
  // token endpoint (RFC 8707). Missing resource remains accepted only for
  // pre-2026 clients that omitted it on both legs.
  if (!resource) {
    if (wasExplicit) throw new InvalidTargetError("The token request is missing its bound MCP resource");
    return;
  }
  if (resource.username || resource.password || resource.search || resource.hash || resource.href !== expected) {
    throw new InvalidTargetError("The token is not valid for the requested resource");
  }
}

function issueAuthorizationCode(data: Omit<PendingMcpAuth, "state">): string {
  cleanupStates();
  if (authorizationCodes.size >= MAX_PENDING_AUTH) {
    throw new TemporarilyUnavailableError("Too many pending authorization requests; retry later");
  }
  const code = randomBytes(32).toString("hex");
  authorizationCodes.set(code, data);
  return code;
}

function redirectAuthorizationError(
  res: Response,
  request: Pick<PendingMcpAuth, "redirectUri" | "state" | "issuer">,
  error: "access_denied" | "server_error" | "temporarily_unavailable",
  description: string,
): void {
  const url = new URL(request.redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (request.state) url.searchParams.set("state", request.state);
  // RFC 9207 requires a simple-string-comparable issuer. Do not normalize the
  // value captured from the authorization handler's configured issuer.
  url.searchParams.set("iss", request.issuer);
  res.redirect(url.href);
}

// --- OAuth Client ID Metadata Documents (CIMD) ---
// The authorization server dereferences attacker-controlled client_id URLs, so
// the fetch is deliberately much stricter than a general HTTP client: public
// HTTPS only, DNS pinned after private-range validation, no redirects, JSON
// content type, five-kilobyte response limit, and a short bounded cache.
const CIMD_MAX_BYTES = 5 * 1024;
const CIMD_TIMEOUT_MS = 5_000;
const CIMD_MAX_CACHE_MS = 10 * 60 * 1000;
const MAX_CIMD_CACHE = 100;
const cimdCache = new Map<string, { client: OAuthClientInformationFull; expiresAt: number }>();
const pendingCimdFetches = new Map<string, Promise<OAuthClientInformationFull | undefined>>();

// Keep IPv4 and IPv6 blocks separate. Node's BlockList treats IPv4 input as an
// IPv4-mapped IPv6 address when both families share one list; combining the
// lists would therefore make the `::ffff:0:0/96` defense reject every public
// IPv4 address too.
const blockedCimdIpv4Addresses = new BlockList();
const blockedCimdIpv6Addresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedCimdIpv4Addresses.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blockedCimdIpv6Addresses.addSubnet(address, prefix, "ipv6");
}

function isPublicCimdAddress(address: string, family: number): boolean {
  if (family === 4) return !blockedCimdIpv4Addresses.check(address, "ipv4");
  if (family === 6) return !blockedCimdIpv6Addresses.check(address, "ipv6");
  return false;
}

function parseCimdUrl(clientId: string): URL | undefined {
  if (clientId.length > 2_048) return undefined;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname === "/"
  ) return undefined;

  // URL parsing normalizes dot segments, so inspect the original path too.
  const rawPath = clientId.slice(clientId.indexOf("/", "https://".length)).split(/[?#]/, 1)[0];
  try {
    if (rawPath.split("/").some((segment) => [".", ".."].includes(decodeURIComponent(segment)))) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return url;
}

async function resolvePublicCimdAddress(hostname: string): Promise<LookupAddress | undefined> {
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    return isPublicCimdAddress(hostname, literalFamily)
      ? { address: hostname, family: literalFamily }
      : undefined;
  }
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") ||
    lower.endsWith(".internal") || lower.endsWith(".home.arpa")
  ) return undefined;
  let addresses: LookupAddress[];
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    return undefined;
  }
  if (addresses.length === 0 || addresses.some(({ address, family }) => !isPublicCimdAddress(address, family))) {
    return undefined;
  }
  return addresses[0];
}

function fetchPinnedCimdJson(url: URL, address: LookupAddress): Promise<{
  value: unknown;
  cacheControl?: string;
}> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = httpsRequest({
      protocol: "https:",
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      servername: url.hostname,
      headers: {
        Accept: "application/json, application/*+json",
        Host: url.host,
        "User-Agent": "whoop-personal-mcp/1.0 CIMD",
      },
      // Pin the already-vetted address so a second DNS answer cannot rebind
      // this request to loopback, link-local, or a private service.
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, [{ address: address.address, family: address.family }]);
          return;
        }
        callback(null, address.address, address.family);
      },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finishReject(new Error("Client metadata endpoint did not return 200"));
        return;
      }
      const contentType = String(response.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json" && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(contentType)) {
        response.resume();
        finishReject(new Error("Client metadata endpoint did not return JSON"));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > CIMD_MAX_BYTES) {
        response.resume();
        finishReject(new Error("Client metadata document is too large"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > CIMD_MAX_BYTES) {
          response.destroy();
          finishReject(new Error("Client metadata document is too large"));
          return;
        }
        chunks.push(buffer);
      });
      response.on("error", (error) => finishReject(error));
      response.on("end", () => {
        if (settled) return;
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          settled = true;
          const cacheControl = response.headers["cache-control"];
          resolve({
            value,
            cacheControl: Array.isArray(cacheControl) ? cacheControl.join(",") : cacheControl,
          });
        } catch {
          finishReject(new Error("Client metadata document is invalid JSON"));
        }
      });
    });
    req.setTimeout(CIMD_TIMEOUT_MS, () => req.destroy(new Error("Client metadata request timed out")));
    req.on("error", finishReject);
    req.end();
  });
}

function parseCimdClient(value: unknown, clientId: string): OAuthClientInformationFull | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const doc = value as Record<string, unknown>;
  if (doc.client_id !== clientId || typeof doc.client_name !== "string" ||
      !doc.client_name.trim() || doc.client_name.length > 200) return undefined;
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0 || doc.redirect_uris.length > 20 ||
      !doc.redirect_uris.every((uri) => typeof uri === "string" && isAllowedRedirectUri(uri))) return undefined;
  if (doc.client_secret !== undefined || doc.client_secret_expires_at !== undefined) return undefined;
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none") return undefined;

  const grantTypes = doc.grant_types === undefined ? ["authorization_code"] : doc.grant_types;
  if (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code") ||
      !grantTypes.every((grant) => grant === "authorization_code" || grant === "refresh_token")) return undefined;
  const responseTypes = doc.response_types === undefined ? ["code"] : doc.response_types;
  if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== "code") return undefined;
  if (doc.application_type !== undefined && doc.application_type !== "native" && doc.application_type !== "web") {
    return undefined;
  }

  return {
    client_id: clientId,
    client_name: doc.client_name.trim(),
    redirect_uris: doc.redirect_uris as string[],
    token_endpoint_auth_method: "none",
    grant_types: grantTypes as string[],
    response_types: ["code"],
    ...(doc.application_type ? { application_type: doc.application_type } : {}),
  } as OAuthClientInformationFull;
}

function cimdCacheLifetime(cacheControl: string | undefined): number {
  if (!cacheControl || /(?:^|,)\s*(?:no-store|no-cache)\b/i.test(cacheControl)) return 0;
  const maxAge = cacheControl.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i)?.[1];
  return maxAge ? Math.min(Number(maxAge) * 1000, CIMD_MAX_CACHE_MS) : 0;
}

async function fetchCimdClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
  const cached = cimdCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.client;
  cimdCache.delete(clientId);

  const existing = pendingCimdFetches.get(clientId);
  if (existing) return existing;
  if (pendingCimdFetches.size >= MAX_CIMD_CACHE) return undefined;

  const task = (async () => {
    const url = parseCimdUrl(clientId);
    if (!url) return undefined;
    const address = await resolvePublicCimdAddress(url.hostname);
    if (!address) return undefined;
    try {
      const { value, cacheControl } = await fetchPinnedCimdJson(url, address);
      const client = parseCimdClient(value, clientId);
      if (!client) return undefined;
      const lifetime = cimdCacheLifetime(cacheControl);
      if (lifetime > 0) {
        while (cimdCache.size >= MAX_CIMD_CACHE) {
          const oldest = cimdCache.keys().next().value as string | undefined;
          if (!oldest) break;
          cimdCache.delete(oldest);
        }
        cimdCache.set(clientId, { client, expiresAt: Date.now() + lifetime });
      }
      return client;
    } catch {
      return undefined;
    }
  })();
  pendingCimdFetches.set(clientId, task);
  try {
    return await task;
  } finally {
    pendingCimdFetches.delete(clientId);
  }
}

// --- SQLite-backed MCP token helpers ---

function dbGetClient(clientId: string): OAuthClientInformationFull | undefined {
  const db = getDb();
  const row = db.prepare("SELECT client_info FROM mcp_clients WHERE client_id = ?").get(clientId) as
    | { client_info: string }
    | undefined;
  if (!row) return undefined;
  return JSON.parse(row.client_info) as OAuthClientInformationFull;
}

// Registration stays open for MCP clients, but never evicts a legitimate client
// on behalf of an unauthenticated registration request.
const MAX_MCP_CLIENTS = 100;

function dbRegisterClient(clientInfo: OAuthClientInformationFull): void {
  const db = getDb();
  db.transaction(() => {
    const now = Math.floor(Date.now() / 1000);
    // Anonymous DCR must not create a permanent storage lockout. Clients that
    // never completed consent/token issuance are disposable after the same
    // short window as pending authorization state.
    db.prepare("DELETE FROM mcp_access_tokens WHERE expires_at < ?").run(now);
    db.prepare("DELETE FROM mcp_refresh_tokens WHERE expires_at < ?").run(now);
    db.prepare(`
      DELETE FROM mcp_clients
      WHERE created_at < ?
        AND NOT EXISTS (SELECT 1 FROM mcp_access_tokens a WHERE a.client_id = mcp_clients.client_id)
        AND NOT EXISTS (SELECT 1 FROM mcp_refresh_tokens r WHERE r.client_id = mcp_clients.client_id)
    `).run(now - Math.ceil(STATE_TTL_MS / 1000));

    const { count } = db.prepare("SELECT COUNT(*) AS count FROM mcp_clients").get() as { count: number };
    if (count >= MAX_MCP_CLIENTS) {
      throw new InvalidClientMetadataError("This single-user deployment has reached its temporary client limit");
    }
    db.prepare("INSERT OR REPLACE INTO mcp_clients (client_id, client_info) VALUES (?, ?)")
      .run(clientInfo.client_id, JSON.stringify(clientInfo));
  })();
}

// MCP tokens are stored hashed (sha256). Incoming tokens are hashed before lookup;
// the raw token is only ever handed back to the client that owns it.
function dbGetAccessToken(token: string): { clientId: string; expiresAt: number } | undefined {
  const db = getDb();
  const row = db.prepare("SELECT client_id, expires_at FROM mcp_access_tokens WHERE token = ?").get(hashToken(token)) as
    | { client_id: string; expires_at: number }
    | undefined;
  return row ? { clientId: row.client_id, expiresAt: row.expires_at } : undefined;
}

function dbSetAccessToken(token: string, clientId: string, expiresAt: number): void {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO mcp_access_tokens (token, client_id, expires_at) VALUES (?, ?, ?)")
    .run(hashToken(token), clientId, expiresAt);
}

function dbGetRefreshToken(token: string): { clientId: string; expiresAt: number } | undefined {
  const db = getDb();
  const row = db.prepare("SELECT client_id, expires_at FROM mcp_refresh_tokens WHERE token = ?").get(hashToken(token)) as
    | { client_id: string; expires_at: number }
    | undefined;
  return row ? { clientId: row.client_id, expiresAt: row.expires_at } : undefined;
}

function dbSetRefreshToken(token: string, clientId: string, expiresAt: number): void {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO mcp_refresh_tokens (token, client_id, expires_at) VALUES (?, ?, ?)")
    .run(hashToken(token), clientId, expiresAt);
}

function dbDeleteRefreshToken(token: string): void {
  const db = getDb();
  db.prepare("DELETE FROM mcp_refresh_tokens WHERE token = ?").run(hashToken(token));
}

/** Start auth maintenance and return an idempotent stop function. */
export function startAuthMaintenance(): () => void {
  const cleanup = () => {
    const now = Math.floor(Date.now() / 1000);
    const db = getDb();
    db.prepare("DELETE FROM mcp_access_tokens WHERE expires_at < ?").run(now);
    db.prepare("DELETE FROM mcp_refresh_tokens WHERE expires_at < ?").run(now);
    cleanupStates();
    prunePasswordAttempts();
    for (const [clientId, cached] of cimdCache) {
      if (cached.expiresAt <= Date.now()) cimdCache.delete(clientId);
    }
  };
  cleanup();
  const timer = setInterval(cleanup, 10 * 60 * 1000);
  timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

// --- OAuthRegisteredClientsStore implementation ---
const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId: string) {
    const client = dbGetClient(clientId);
    if (client) {
      console.log(`[auth] getClient ${clientId.slice(0, 8)}… → registered client found`);
      return client;
    }
    const cimdClient = await fetchCimdClient(clientId);
    console.log(`[auth] getClient ${clientId.slice(0, 8)}… → ${cimdClient ? "CIMD resolved" : "NOT FOUND"}`);
    return cimdClient;
  },
  registerClient(clientInfo: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) {
    // Anti-phishing: only register redirect targets on the allowed-host list
    // (https + exact hostname match; localhost also allowed over http).
    for (const uri of clientInfo.redirect_uris) {
      if (!isAllowedRedirectUri(uri)) {
        console.error(`[auth] registerClient REJECTED — disallowed redirect_uri`);
        throw new InvalidClientMetadataError(
          "redirect_uris must be https on an allowed host (http allowed only for localhost)",
        );
      }
    }
    const clientId = randomBytes(16).toString("hex");
    const full: OAuthClientInformationFull = {
      ...clientInfo,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    dbRegisterClient(full);
    console.log(`[auth] registerClient → ${clientId.slice(0, 8)}…`);
    return full;
  },
};

// --- OAuthServerProvider implementation ---
export const oauthProvider: OAuthServerProvider = {
  authorizationResponseIssParameterSupported: true,

  get clientsStore() {
    return clientsStore;
  },

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // Do not copy redirect query parameters (which some clients use for tenant
    // or state values) into platform logs. The consent page separately shows
    // the owner a sanitized destination host.
    console.log(`[auth] authorize called for client ${client.client_id.slice(0, 8)}…`);
    const scopes = resolveMcpScopes(params.scopes);
    const target = resolveMcpResource(params.resource);
    const issuer = params.issuer ?? new URL(config.server.publicUrl).href;
    // Consent gate: never auto-approve. Stash the pending authorization and require
    // the resource owner to prove ownership (ACCESS_PASSWORD) before any code is issued.
    cleanupStates();
    if (pendingConsent.size >= MAX_PENDING_AUTH) {
      throw new TemporarilyUnavailableError("Too many pending consent requests; retry later");
    }
    const consentId = randomBytes(16).toString("hex");
    pendingConsent.set(consentId, {
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      issuer,
      scopes,
      ...target,
      createdAt: Date.now(),
    });
    console.log(`[auth] consent gate → rendering form for consentId ${consentId.slice(0, 8)}…`);
    sendConsentPage(res, consentId, client.client_name, params.redirectUri, undefined, client.client_id);
  },

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const data = authorizationCodes.get(authorizationCode);
    console.log(`[auth] challengeForAuthorizationCode → ${data ? "found" : "NOT FOUND"} (stored codes: ${authorizationCodes.size})`);
    if (!data || data.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    // Enforce the code TTL at use, not just at the 10-min sweep.
    if (Date.now() - data.createdAt > AUTH_CODE_TTL_MS) {
      authorizationCodes.delete(authorizationCode);
      console.error(`[auth] challengeForAuthorizationCode FAILED — code expired`);
      throw new InvalidGrantError("Invalid authorization code");
    }
    return data.codeChallenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const data = authorizationCodes.get(authorizationCode);
    if (!data || data.clientId !== client.client_id) {
      console.error(`[auth] exchangeAuthorizationCode FAILED — code ${data ? "found but clientId mismatch" : "NOT FOUND"}`);
      throw new InvalidGrantError("Invalid authorization code");
    }
    // Enforce the code TTL at use, not just at the 10-min sweep.
    if (Date.now() - data.createdAt > AUTH_CODE_TTL_MS) {
      authorizationCodes.delete(authorizationCode);
      console.error(`[auth] exchangeAuthorizationCode FAILED — code expired`);
      throw new InvalidGrantError("Invalid authorization code");
    }
    // Bind the redirect_uri: it is always recorded at issue, so require the
    // incoming value to be present AND exactly equal (mandatory, not optional).
    if (redirectUri === undefined || redirectUri !== data.redirectUri) {
      console.error(`[auth] exchangeAuthorizationCode FAILED — redirect_uri missing or mismatch`);
      throw new InvalidGrantError("Invalid authorization code");
    }
    validateTokenResource(resource, data.resource, data.resourceWasExplicit);
    console.log(`[auth] exchangeAuthorizationCode → success, issuing access + refresh tokens`);
    authorizationCodes.delete(authorizationCode);

    const accessToken = randomBytes(32).toString("hex");
    const canRefresh = client.grant_types?.includes("refresh_token") ?? false;
    const refreshToken = canRefresh ? randomBytes(32).toString("hex") : undefined;
    const now = Math.floor(Date.now() / 1000);
    dbSetAccessToken(accessToken, client.client_id, now + ACCESS_TOKEN_TTL_S);
    if (refreshToken) dbSetRefreshToken(refreshToken, client.client_id, now + REFRESH_TOKEN_TTL_S);

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      scope: data.scopes.join(" "),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (!client.grant_types?.includes("refresh_token")) {
      throw new InvalidGrantError("This client is not registered for refresh tokens");
    }
    const grantedScopes = resolveMcpScopes(scopes);
    if (resource) validateTokenResource(resource, canonicalMcpResource(), false);
    const data = dbGetRefreshToken(refreshToken);
    if (!data || data.clientId !== client.client_id) {
      console.error(`[auth] exchangeRefreshToken FAILED — token ${data ? "found but clientId mismatch" : "NOT FOUND"}`);
      throw new InvalidGrantError("Invalid refresh token");
    }
    const now = Math.floor(Date.now() / 1000);
    if (now > data.expiresAt) {
      dbDeleteRefreshToken(refreshToken);
      throw new InvalidGrantError("Refresh token expired");
    }

    // Rotate: delete old, issue new
    dbDeleteRefreshToken(refreshToken);

    const newAccessToken = randomBytes(32).toString("hex");
    const newRefreshToken = randomBytes(32).toString("hex");
    dbSetAccessToken(newAccessToken, client.client_id, now + ACCESS_TOKEN_TTL_S);
    dbSetRefreshToken(newRefreshToken, client.client_id, now + REFRESH_TOKEN_TTL_S);

    return {
      access_token: newAccessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: newRefreshToken,
      scope: grantedScopes.join(" "),
    };
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Check dynamic tokens from SQLite
    const data = dbGetAccessToken(token);
    if (data && Math.floor(Date.now() / 1000) < data.expiresAt) {
      console.log(`[auth] verifyAccessToken → dynamic token valid (client ${data.clientId.slice(0, 8)}…)`);
      return {
        token,
        clientId: data.clientId,
        scopes: [...MCP_REQUIRED_SCOPES],
        expiresAt: data.expiresAt,
      };
    }

    // Check static bearer token (only when one is configured)
    const staticToken = config.security.mcpBearerToken;
    if (staticToken && bearerTokensMatch(token, staticToken)) {
      console.log(`[auth] verifyAccessToken → static bearer token`);
      return {
        token,
        clientId: "static",
        scopes: [...MCP_REQUIRED_SCOPES],
        // Recomputed each request, so the static token never really expires; this
        // satisfies the SDK's requireBearerAuth, which 401s tokens with no expiry.
        expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_S,
      };
    }

    console.error(`[auth] verifyAccessToken REJECTED — token not found in DB and not static`);
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired token");
  },

  async revokeToken(client, request): Promise<void> {
    const tokenHash = hashToken(request.token);
    const db = getDb();
    db.transaction(() => {
      db.prepare("DELETE FROM mcp_access_tokens WHERE token = ? AND client_id = ?")
        .run(tokenHash, client.client_id);
      db.prepare("DELETE FROM mcp_refresh_tokens WHERE token = ? AND client_id = ?")
        .run(tokenHash, client.client_id);
    })();
  },
};

/**
 * Sends an intermediate HTML page instead of a bare 302 redirect for the
 * Whoop OAuth URL.  Mobile in-app browsers (SFSafariViewController / Chrome
 * Custom Tabs) can close immediately on rapid cross-domain 302 chains before
 * the destination page ever renders.  Serving a real HTML page keeps the
 * browser open; the page auto-redirects after a short delay and provides a
 * manual fallback link so the user always reaches the Whoop login.
 */
function sendAuthRedirectPage(res: Response, whoopUrl: string): void {
  setSensitivePageHeaders(res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connecting to WHOOP</title>
  <meta http-equiv="refresh" content="2;url=${escapeHtml(whoopUrl)}">
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;display:flex;
         align-items:center;justify-content:center;min-height:100vh;
         margin:0;background:#0f0f0f;color:#fff;text-align:center}
    .card{max-width:400px;padding:2rem}
    .spinner{width:40px;height:40px;margin:0 auto 1.5rem;border:3px solid #333;
             border-top-color:#44d62c;border-radius:50%;
             animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    a{color:#44d62c;font-weight:600;text-decoration:none}
    a:hover{text-decoration:underline}
    .hint{color:#999;font-size:.85rem;margin-top:1.5rem}
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h2>Connecting to WHOOP&hellip;</h2>
    <p>You&rsquo;ll be redirected to sign in with your WHOOP account.</p>
    <p class="hint">This is a one-user, self-hosted wellness tool. It is not medical care and should not be used for diagnosis or emergency decisions.</p>
    <p style="margin-top:1.5rem"><a id="link" href="${escapeHtml(whoopUrl)}">Tap here if you&rsquo;re not redirected</a></p>
    <p class="hint">Keep this browser open until sign-in is complete.</p>
  </div>
</body>
</html>`);
}

/**
 * Renders a dark-styled password form (same visual language as
 * sendAuthRedirectPage).  Used by both the client-consent gate and the
 * WHOOP account-linking flow.  All interpolated values are HTML-escaped —
 * `title`/`description` can carry an attacker-controlled `client_name`.
 */
function sendPasswordPage(
  res: Response,
  opts: {
    action: string;
    title: string;
    description: string;
    hidden?: Record<string, string>;
    error?: string;
    acknowledgmentText?: string;
  }
): void {
  const hiddenInputs = Object.entries(opts.hidden ?? {})
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  setSensitivePageHeaders(res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(opts.error ? 401 : 200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.title)}</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;display:flex;
         align-items:center;justify-content:center;min-height:100vh;
         margin:0;background:#0f0f0f;color:#fff;text-align:center}
    .card{max-width:400px;padding:2rem;width:100%;box-sizing:border-box}
    h2{margin:0 0 .5rem}
    p{color:#ccc}
    form{margin-top:1.5rem}
    input[type=password]{width:100%;box-sizing:border-box;padding:.75rem;
         border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#fff;font-size:1rem}
    .ack{display:flex;gap:.65rem;text-align:left;align-items:flex-start;margin-top:1rem;
         color:#ccc;font-size:.9rem;line-height:1.35}
    .ack input{margin-top:.2rem;flex:none}
    button{width:100%;padding:.75rem;margin-top:1rem;border:none;border-radius:8px;
         background:#44d62c;color:#000;font-weight:700;font-size:1rem;cursor:pointer}
    button:hover{background:#3ac024}
    .err{color:#ff5555;font-size:.9rem;margin-top:1rem}
    .hint{color:#999;font-size:.85rem;margin-top:1.5rem}
  </style>
</head>
<body>
  <div class="card">
    <h2>${escapeHtml(opts.title)}</h2>
    <p>${escapeHtml(opts.description)}</p>
    <p class="hint">General wellness and fitness context only. This service is not medical care or advice, diagnosis, treatment, injury prediction, exercise clearance, or emergency support.</p>
    <form method="post" action="${escapeHtml(opts.action)}">
      ${hiddenInputs}
      <input type="password" name="password" placeholder="Access password" autofocus required autocomplete="current-password">
      ${opts.acknowledgmentText ? `<label class="ack"><input type="checkbox" name="wellnessConsent" value="yes" required><span>${escapeHtml(opts.acknowledgmentText)}</span></label>` : ""}
      <button type="submit">Continue</button>
      ${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ""}
    </form>
    <p class="hint">This password protects access to the single linked WHOOP account on this deployment.</p>
  </div>
</body>
</html>`);
}

// Renders the client-consent gate form (POSTs to /auth/consent with a single-use consentId).
// Also surfaces the concrete redirect_uri host so the owner sees where data will go
// (anti-phishing transparency); the host is escaped by sendPasswordPage.
function sendConsentPage(
  res: Response,
  consentId: string,
  clientName?: string,
  redirectUri?: string,
  error?: string,
  clientId?: string,
): void {
  const who = clientName ? `"${clientName}"` : "An application";
  let identity = "";
  if (clientId) {
    try {
      const idUrl = parseCimdUrl(clientId);
      if (idUrl) identity = ` Its published client identity is hosted at ${idUrl.host}.`;
    } catch {
      identity = "";
    }
  }
  let destination = "";
  let destinationLabel = "the displayed destination";
  if (redirectUri) {
    try {
      destinationLabel = new URL(redirectUri).host;
      destination = ` This will send your data to: ${destinationLabel}.`;
    } catch {
      destination = "";
    }
  }
  sendPasswordPage(res, {
    action: "/auth/consent",
    title: "Authorize access",
    description: `${who} wants to connect to your WHOOP data.${identity}${destination} Enter your access password to approve.`,
    hidden: { consentId },
    error,
    acknowledgmentText: `I explicitly authorize ${who} at ${destinationLabel} to receive, process, and potentially retain the WHOOP wellness data requested through this connection.`,
  });
}

const WHOOP_LINK_FORM = {
  action: "/auth/whoop",
  title: "Link your WHOOP account",
  description: "Link one WHOOP account to this one-user, self-hosted wellness service.",
  acknowledgmentText: "I confirm this is my WHOOP account. I authorize this service to access its wellness data, which will be sent only to clients I later explicitly authorize.",
} as const;

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");

  // Disabled by default so directly exposed deployments cannot spoof client IPs
  // through X-Forwarded-For and bypass per-IP password throttling.
  app.set("trust proxy", config.server.trustProxy);

  const verifyAccessPassword = createPasswordVerifier(config.security.accessPassword);
  // This request-volume limit protects the expensive authorization, database,
  // and upstream-revocation work on owner auth routes. The stricter failed-
  // password lockout below remains separate and shared across password forms.
  const authOperationRateLimit = rateLimit({
    windowMs: PW_WINDOW_MS,
    limit: 100,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });

  const corsAllowlist = new Set(config.security.allowedOrigins);
  const hostAllowlist = new Set(config.security.allowedHosts);
  const isAllowedOrigin = (origin: string): boolean => {
    try {
      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
          parsed.search || parsed.hash || parsed.pathname !== "/") return false;
      return corsAllowlist.has(parsed.origin);
    } catch {
      return false;
    }
  };
  const isAllowedHost = (value: string | undefined): boolean => {
    if (!value || value.includes(",") || value.includes("/") || value.includes("@")) return false;
    const host = value.trim().toLowerCase();
    return hostAllowlist.has(host);
  };

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (req.path.startsWith("/auth/")) setSensitivePageHeaders(res);
    res.setHeader("Vary", "Origin");
    // MCP requires deny-on-failure Origin validation; merely withholding a CORS
    // response header does not prevent DNS-rebinding requests from reaching it.
    if (req.path === "/mcp" || req.path === "/mcp/") {
      if (!isAllowedHost(req.headers.host)) {
        res.status(421).json({ error: { code: "HOST_NOT_ALLOWED", message: "Request host is not allowed" } });
        return;
      }
      if (origin && !isAllowedOrigin(origin)) {
        res.status(403).json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Request origin is not allowed" } });
        return;
      }
    }
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", new URL(origin).origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
    );
    // Browser-based MCP clients must be able to inspect the Bearer challenge
    // to discover resource metadata and required scopes.
    res.setHeader("Access-Control-Expose-Headers", "MCP-Protocol-Version, WWW-Authenticate");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: "64kb" }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));

  // MCP Auth Router (handles /.well-known/*, /authorize, /token, /register)
  const issuerUrl = new URL(config.server.publicUrl);
  const resourceServerUrl = new URL("/mcp", issuerUrl);
  const oauthMetadata: OAuthMetadata & { client_id_metadata_document_supported: true } = {
    ...createOAuthMetadata({
      provider: oauthProvider,
      issuerUrl,
      scopesSupported: [...MCP_REQUIRED_SCOPES],
    }),
    // CIMD is preferred by MCP 2026-07-28. /register remains advertised by
    // the legacy router solely as a backwards-compatible DCR fallback.
    client_id_metadata_document_supported: true,
  };

  // The legacy AS helper does not know about CIMD, so publish its metadata
  // explicitly before mounting the otherwise standards-compliant router.
  app.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(oauthMetadata);
  });

  app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    resourceServerUrl,
    scopesSupported: [...MCP_REQUIRED_SCOPES],
    resourceName: "WHOOP Personal MCP",
  }));

  // Health check
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // Whoop auth status — requires the static bearer token to prevent info leak.
  // When no static token is configured, this endpoint is 401 for everything.
  app.get("/auth/status", (req: Request, res: Response) => {
    const staticToken = config.security.mcpBearerToken;
    const authHeader = req.headers.authorization ?? "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!staticToken || !provided || !bearerTokensMatch(provided, staticToken)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const tokens = getTokens();
    if (!tokens) {
      res.json({ authenticated: false });
      return;
    }
    res.json({
      authenticated: true,
      expires_at: new Date(tokens.expiresAt * 1000).toISOString(),
      scopes: tokens.scope,
    });
  });

  // Privacy wipe for this one-user deployment. A valid dynamic MCP bearer or
  // the optional static deployment bearer is required; browser cookies are not
  // used, which keeps this endpoint resistant to ambient-authority CSRF.
  app.post("/auth/disconnect", authOperationRateLimit, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const authHeader = req.headers.authorization ?? "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!provided) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Bearer authentication is required" } });
      return;
    }
    try {
      await oauthProvider.verifyAccessToken(provided);
    } catch {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Bearer authentication is invalid" } });
      return;
    }

    if (rejectIfRateLimited(req, res)) return;

    const accessPassword = typeof req.body?.access_password === "string"
      ? req.body.access_password
      : "";
    if (!accessPassword || !verifyAccessPassword(accessPassword)) {
      recordPwFailure(req.ip ?? "unknown");
      res.status(403).json({
        error: {
          code: "OWNER_CONFIRMATION_REQUIRED",
          message: "The owner access password is required for this destructive operation",
        },
      });
      return;
    }
    resetPwAttempts(req.ip ?? "unknown");

    try {
      // disconnectAndDeleteData invalidates and deletes persisted credentials
      // synchronously before it waits for best-effort upstream revocation.
      const disconnect = disconnectAndDeleteData();
      pendingStates.clear();
      pendingMcpAuth.clear();
      pendingConsent.clear();
      authorizationCodes.clear();
      cimdCache.clear();
      pwAttempts.clear();
      const closeSessions = app.locals.closeMcpSessions as (() => Promise<void>) | undefined;
      if (closeSessions) await closeSessions();
      const result = await disconnect;
      res.json({
        status: "disconnected",
        local_data_deleted: true,
        whoop_revocation: result.revocation,
        manual_whoop_revocation_required:
          result.revocation === "failed" || result.revocation === "unavailable",
      });
    } catch (error) {
      console.error(`[auth] disconnect failed: ${error instanceof Error ? error.message : "unknown error"}`);
      res.status(500).json({ error: { code: "DISCONNECT_FAILED", message: "Disconnect could not be completed" } });
    }
  });

  // Consent gate — validate ACCESS_PASSWORD, then complete the pending MCP authorization.
  app.post("/auth/consent", authOperationRateLimit, (req: Request, res: Response) => {
    if (rejectIfRateLimited(req, res)) return;
    const body = req.body as { consentId?: unknown; password?: unknown; wellnessConsent?: unknown };
    const consentId = typeof body.consentId === "string" ? body.consentId : "";
    const password = typeof body.password === "string" ? body.password : "";

    // Single use: look up and delete immediately.
    const pending = takeFresh(pendingConsent, consentId);

    if (!pending) {
      console.error(`[auth] /auth/consent REJECTED — consentId ${consentId ? "expired/unknown" : "missing"}`);
      res.status(400).send("Consent request expired. Please restart the connection from your client.");
      return;
    }

    const passwordMatches = verifyAccessPassword(password);
    if (!passwordMatches || body.wellnessConsent !== "yes") {
      if (!passwordMatches) recordPwFailure(req.ip ?? "unknown");
      // Re-arm a fresh single-use consentId carrying the same pending params.
      cleanupStates();
      const freshId = randomBytes(16).toString("hex");
      pendingConsent.set(freshId, { ...pending, createdAt: Date.now() });
      console.error(`[auth] /auth/consent REJECTED — credentials or acknowledgment missing`);
      sendConsentPage(
        res,
        freshId,
        pending.clientName,
        pending.redirectUri,
        "Enter the correct password and acknowledge the wellness-only notice.",
        pending.clientId,
      );
      return;
    }

    resetPwAttempts(req.ip ?? "unknown");
    console.log(`[auth] /auth/consent OK — client ${pending.clientId.slice(0, 8)}… approved`);

    // If WHOOP tokens already exist, issue the MCP authorization code now.
    if (getTokens()) {
      let code: string;
      try {
        code = issueAuthorizationCode({
          clientId: pending.clientId,
          codeChallenge: pending.codeChallenge,
          redirectUri: pending.redirectUri,
          issuer: pending.issuer,
          scopes: pending.scopes,
          resource: pending.resource,
          resourceWasExplicit: pending.resourceWasExplicit,
          createdAt: Date.now(),
        });
      } catch {
        redirectAuthorizationError(
          res,
          pending,
          "temporarily_unavailable",
          "Too many pending authorization requests; retry later",
        );
        return;
      }
      const url = new URL(pending.redirectUri);
      url.searchParams.set("code", code);
      if (pending.state) url.searchParams.set("state", pending.state);
      url.searchParams.set("iss", pending.issuer);
      console.log(`[auth] Whoop tokens exist → issuing code, redirecting to client`);
      res.redirect(url.toString());
      return;
    }

    // No WHOOP tokens — chain to WHOOP OAuth, then complete MCP auth on callback.
    console.log(`[auth] No Whoop tokens → chaining to Whoop OAuth`);
    cleanupStates();
    if (pendingStates.size >= MAX_PENDING_AUTH || pendingMcpAuth.size >= MAX_PENDING_AUTH) {
      redirectAuthorizationError(
        res,
        pending,
        "temporarily_unavailable",
        "Too many pending authorization requests; retry later",
      );
      return;
    }
    const whoopState = randomBytes(16).toString("hex");
    pendingStates.set(whoopState, Date.now());
    pendingMcpAuth.set(whoopState, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      state: pending.state,
      codeChallenge: pending.codeChallenge,
      issuer: pending.issuer,
      scopes: pending.scopes,
      resource: pending.resource,
      resourceWasExplicit: pending.resourceWasExplicit,
      createdAt: Date.now(),
    });
    console.log(`[auth] pendingMcpAuth stored for state ${whoopState.slice(0, 8)}…, pendingStates size=${pendingStates.size}, pendingMcpAuth size=${pendingMcpAuth.size}`);
    const whoopUrl = buildAuthUrl(whoopState);
    sendAuthRedirectPage(res, whoopUrl);
  });

  // Start Whoop OAuth flow — gated behind the access password.
  app.get("/auth/whoop", (_req: Request, res: Response) => {
    sendPasswordPage(res, { ...WHOOP_LINK_FORM });
  });

  app.post("/auth/whoop", authOperationRateLimit, (req: Request, res: Response) => {
    if (rejectIfRateLimited(req, res)) return;
    const body = req.body as { password?: unknown; wellnessConsent?: unknown };
    const password = typeof body.password === "string" ? body.password : "";
    const passwordMatches = verifyAccessPassword(password);
    if (!passwordMatches || body.wellnessConsent !== "yes") {
      if (!passwordMatches) recordPwFailure(req.ip ?? "unknown");
      console.error(`[auth] POST /auth/whoop REJECTED — wrong password`);
      sendPasswordPage(res, { ...WHOOP_LINK_FORM, error: "Enter the correct password and acknowledge the wellness-only notice." });
      return;
    }
    resetPwAttempts(req.ip ?? "unknown");
    if (getTokens()) {
      res.status(409).send("A WHOOP account is already linked. Disconnect it before linking another account.");
      return;
    }
    cleanupStates();
    if (pendingStates.size >= MAX_PENDING_AUTH) {
      res.status(503).send("Too many pending authorization requests. Please retry shortly.");
      return;
    }
    const state = randomBytes(16).toString("hex");
    pendingStates.set(state, Date.now());
    const whoopUrl = buildAuthUrl(state);
    sendAuthRedirectPage(res, whoopUrl);
  });

  // Whoop OAuth callback
  app.get("/auth/whoop/callback", authOperationRateLimit, async (req: Request, res: Response) => {
    console.log(`[callback] WHOOP callback received — code=${req.query.code ? "present" : "missing"}, state=${req.query.state ? "present" : "missing"}`);
    const { code, state } = req.query;

    if (!state || typeof state !== "string" || !takeFreshTimestamp(pendingStates, state)) {
      if (typeof state === "string") pendingMcpAuth.delete(state);
      console.error(`[callback] REJECTED — invalid or expired state`);
      res.status(400).send("Invalid or expired state parameter");
      return;
    }

    const hadPendingMcpAuth = pendingMcpAuth.has(state);
    const mcpAuth = takeFresh(pendingMcpAuth, state);
    if (hadPendingMcpAuth && !mcpAuth) {
      res.status(400).send("Invalid or expired state parameter");
      return;
    }

    if (!code || typeof code !== "string") {
      console.error(`[callback] REJECTED — missing authorization code`);
      if (mcpAuth) {
        redirectAuthorizationError(
          res,
          mcpAuth,
          req.query.error === "access_denied" ? "access_denied" : "server_error",
          req.query.error === "access_denied" ? "The resource owner denied access" : "Authorization failed",
        );
        return;
      }
      res.status(400).send("Missing authorization code");
      return;
    }

    try {
      console.log(`[callback] Exchanging Whoop auth code for tokens…`);
      await exchangeCodeForTokens(code);
      console.log(`[callback] Whoop tokens stored successfully`);

      // Check if this was part of a chained MCP auth flow
      console.log(`[callback] pendingMcpAuth for state ${state.slice(0, 8)}… → ${mcpAuth ? "FOUND (chained flow)" : "NOT FOUND (standalone)"}`);
      if (mcpAuth) {
        // Complete MCP authorization by generating a code for the registered client.
        const mcpCode = issueAuthorizationCode({
          clientId: mcpAuth.clientId,
          codeChallenge: mcpAuth.codeChallenge,
          redirectUri: mcpAuth.redirectUri,
          issuer: mcpAuth.issuer,
          scopes: mcpAuth.scopes,
          resource: mcpAuth.resource,
          resourceWasExplicit: mcpAuth.resourceWasExplicit,
          createdAt: Date.now(),
        });

        const url = new URL(mcpAuth.redirectUri);
        url.searchParams.set("code", mcpCode);
        if (mcpAuth.state) url.searchParams.set("state", mcpAuth.state);
        url.searchParams.set("iss", mcpAuth.issuer);

        console.log(`[callback] Chained MCP auth complete → redirecting to ${url.origin}${url.pathname}`);
        res.redirect(url.toString());
        return;
      }

      // Standalone Whoop auth (not part of MCP flow)
      console.log(`[callback] Standalone auth complete → showing success page`);
      res.send(`
        <!DOCTYPE html>
        <html><body style="font-family:system-ui;text-align:center;padding:4rem">
          <h1>Connected!</h1>
          <p>Your Whoop account is linked. You can close this tab.</p>
        </body></html>
      `);
    } catch (err) {
      // Log the detail server-side; return only a generic message to the client.
      console.error(`[callback] authorization failed: ${err instanceof Error ? err.message : "unknown error"}`);
      if (!res.headersSent) {
        if (mcpAuth) {
          redirectAuthorizationError(res, mcpAuth, "server_error", "Authorization failed");
          return;
        }
        res.status(500).send("Authorization failed");
      }
    }
  });

  // Global error handler — log the detail, return a generic message.
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof err.status === "number" && err.status >= 400 && err.status < 500
      ? err.status
      : 500;
    console.error(`[server] request failed (${status})`);
    if (!res.headersSent) {
      res.status(status).json({
        error: status === 413 ? "Request body too large" : status < 500 ? "Invalid request" : "Internal server error",
      });
    }
  });

  return app;
}
