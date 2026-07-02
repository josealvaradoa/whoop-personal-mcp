import express from "express";
import type { Request, Response, NextFunction } from "express";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { config } from "./config.js";
import { buildAuthUrl, exchangeCodeForTokens, getTokens } from "./whoop/auth.js";
import { getDb } from "./db/connection.js";

// --- Whoop OAuth state store ---
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

// Pending MCP auth params stored while user completes Whoop OAuth
interface PendingMcpAuth {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
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
  createdAt: number;
}
const pendingConsent = new Map<string, PendingConsent>();

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
}

// sha256 hex — used to store MCP tokens at rest so a DB leak yields no live credentials.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Constant-time secret comparison. Hashing both sides first makes the buffers
// equal-length (timingSafeEqual throws on length mismatch) and hides input length.
function secretsMatch(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest()
  );
}

// --- Password-endpoint rate limiting (dependency-free, in-memory, per-IP) ---
// Throttles brute-force password guessing on POST /auth/consent and /auth/whoop.
// After MAX_PW_ATTEMPTS failures from one IP within PW_WINDOW_MS the IP is locked
// out (429 + Retry-After) until the window elapses; a correct password resets it.
const PW_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_PW_ATTEMPTS = 5;
const pwAttempts = new Map<string, { count: number; first: number }>();

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

// Redirect-URI allowlist (consent-gate phishing mitigation). A remote redirect
// target must be https AND have a hostname that EXACTLY equals an allowed host
// (config.security.allowedRedirectHosts) — no suffix/substring matching, so
// claude.ai.evil.com and sub.claude.ai.evil.com are rejected. localhost and
// 127.0.0.1 stay allowed (http included) for local dev / curl.
function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    (host === "localhost" || host === "127.0.0.1")
  ) {
    return true;
  }
  return parsed.protocol === "https:" && config.security.allowedRedirectHosts.includes(host);
}

// --- MCP OAuth: short-lived state in-memory, persistent state in SQLite ---
const authorizationCodes = new Map<string, { clientId: string; codeChallenge: string; redirectUri: string; createdAt: number }>();
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const ACCESS_TOKEN_TTL_S = 3600; // 1 hour
const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600; // 30 days

// --- SQLite-backed MCP token helpers ---

function dbGetClient(clientId: string): OAuthClientInformationFull | undefined {
  const db = getDb();
  const row = db.prepare("SELECT client_info FROM mcp_clients WHERE client_id = ?").get(clientId) as
    | { client_info: string }
    | undefined;
  if (!row) return undefined;
  return JSON.parse(row.client_info) as OAuthClientInformationFull;
}

// Registration stays open (Claude self-registers), so bound storage: keep at most
// MAX_MCP_CLIENTS rows, evicting the oldest by created_at (rowid breaks same-second ties).
const MAX_MCP_CLIENTS = 100;

function dbRegisterClient(clientInfo: OAuthClientInformationFull): void {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO mcp_clients (client_id, client_info) VALUES (?, ?)")
    .run(clientInfo.client_id, JSON.stringify(clientInfo));
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM mcp_clients").get() as { count: number };
  if (count > MAX_MCP_CLIENTS) {
    db.prepare(
      `DELETE FROM mcp_clients WHERE client_id IN (
         SELECT client_id FROM mcp_clients ORDER BY created_at ASC, rowid ASC LIMIT ?
       )`
    ).run(count - MAX_MCP_CLIENTS);
    console.log(`[auth] mcp_clients capped at ${MAX_MCP_CLIENTS} — evicted ${count - MAX_MCP_CLIENTS} oldest`);
  }
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

// Cleanup expired tokens every 10 minutes
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();
  db.prepare("DELETE FROM mcp_access_tokens WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM mcp_refresh_tokens WHERE expires_at < ?").run(now);
  const nowMs = Date.now();
  for (const [code, data] of authorizationCodes) {
    if (nowMs - data.createdAt > AUTH_CODE_TTL_MS) authorizationCodes.delete(code);
  }
}, 10 * 60 * 1000);

// --- OAuthRegisteredClientsStore implementation ---
const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId: string) {
    const client = dbGetClient(clientId);
    console.log(`[auth] getClient ${clientId.slice(0, 8)}… → ${client ? "found" : "NOT FOUND"}`);
    return client;
  },
  registerClient(clientInfo: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) {
    // Anti-phishing: only register redirect targets on the allowed-host list
    // (https + exact hostname match; localhost also allowed over http).
    for (const uri of clientInfo.redirect_uris) {
      if (!isAllowedRedirectUri(uri)) {
        console.error(`[auth] registerClient REJECTED — disallowed redirect_uri`);
        throw new Error("redirect_uris must be https on an allowed host (http allowed only for localhost)");
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
  get clientsStore() {
    return clientsStore;
  },

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    console.log(`[auth] authorize called for client ${client.client_id.slice(0, 8)}…, redirectUri=${params.redirectUri}`);
    // Consent gate: never auto-approve. Stash the pending authorization and require
    // the resource owner to prove ownership (ACCESS_PASSWORD) before any code is issued.
    cleanupStates();
    const consentId = randomBytes(16).toString("hex");
    pendingConsent.set(consentId, {
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      createdAt: Date.now(),
    });
    console.log(`[auth] consent gate → rendering form for consentId ${consentId.slice(0, 8)}…`);
    sendConsentPage(res, consentId, client.client_name, params.redirectUri);
  },

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const data = authorizationCodes.get(authorizationCode);
    console.log(`[auth] challengeForAuthorizationCode → ${data ? "found" : "NOT FOUND"} (stored codes: ${authorizationCodes.size})`);
    if (!data) throw new Error("Invalid authorization code");
    // Enforce the code TTL at use, not just at the 10-min sweep.
    if (Date.now() - data.createdAt > AUTH_CODE_TTL_MS) {
      authorizationCodes.delete(authorizationCode);
      console.error(`[auth] challengeForAuthorizationCode FAILED — code expired`);
      throw new Error("Invalid authorization code");
    }
    return data.codeChallenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    const data = authorizationCodes.get(authorizationCode);
    if (!data || data.clientId !== client.client_id) {
      console.error(`[auth] exchangeAuthorizationCode FAILED — code ${data ? "found but clientId mismatch" : "NOT FOUND"}`);
      throw new Error("Invalid authorization code");
    }
    // Enforce the code TTL at use, not just at the 10-min sweep.
    if (Date.now() - data.createdAt > AUTH_CODE_TTL_MS) {
      authorizationCodes.delete(authorizationCode);
      console.error(`[auth] exchangeAuthorizationCode FAILED — code expired`);
      throw new Error("Invalid authorization code");
    }
    // Bind the redirect_uri: it is always recorded at issue, so require the
    // incoming value to be present AND exactly equal (mandatory, not optional).
    if (redirectUri === undefined || redirectUri !== data.redirectUri) {
      console.error(`[auth] exchangeAuthorizationCode FAILED — redirect_uri missing or mismatch`);
      throw new Error("Invalid authorization code");
    }
    console.log(`[auth] exchangeAuthorizationCode → success, issuing access + refresh tokens`);
    authorizationCodes.delete(authorizationCode);

    const accessToken = randomBytes(32).toString("hex");
    const refreshToken = randomBytes(32).toString("hex");
    const now = Math.floor(Date.now() / 1000);
    dbSetAccessToken(accessToken, client.client_id, now + ACCESS_TOKEN_TTL_S);
    dbSetRefreshToken(refreshToken, client.client_id, now + REFRESH_TOKEN_TTL_S);

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
    };
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string
  ): Promise<OAuthTokens> {
    const data = dbGetRefreshToken(refreshToken);
    if (!data || data.clientId !== client.client_id) {
      console.error(`[auth] exchangeRefreshToken FAILED — token ${data ? "found but clientId mismatch" : "NOT FOUND"}`);
      throw new Error("Invalid refresh token");
    }
    const now = Math.floor(Date.now() / 1000);
    if (now > data.expiresAt) {
      dbDeleteRefreshToken(refreshToken);
      throw new Error("Refresh token expired");
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
        scopes: [],
        expiresAt: data.expiresAt,
      };
    }

    // Check static bearer token (only when one is configured)
    const staticToken = config.security.mcpBearerToken;
    if (staticToken && secretsMatch(token, staticToken)) {
      console.log(`[auth] verifyAccessToken → static bearer token`);
      return {
        token,
        clientId: "static",
        scopes: [],
        // Recomputed each request, so the static token never really expires; this
        // satisfies the SDK's requireBearerAuth, which 401s tokens with no expiry.
        expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_S,
      };
    }

    console.error(`[auth] verifyAccessToken REJECTED — token not found in DB and not static`);
    throw new Error("Invalid or expired token");
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
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connecting to WHOOP</title>
  <meta http-equiv="refresh" content="2;url=${encodeURI(whoopUrl)}">
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
    <p style="margin-top:1.5rem"><a id="link" href="${encodeURI(whoopUrl)}">Tap here if you&rsquo;re not redirected</a></p>
    <p class="hint">Keep this browser open until sign-in is complete.</p>
  </div>
  <script>
    // Use location.replace so the back button skips this interstitial
    setTimeout(function(){location.replace(${JSON.stringify(whoopUrl)})},1500);
  </script>
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
  }
): void {
  const hiddenInputs = Object.entries(opts.hidden ?? {})
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
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
    <form method="post" action="${escapeHtml(opts.action)}">
      ${hiddenInputs}
      <input type="password" name="password" placeholder="Access password" autofocus required autocomplete="current-password">
      <button type="submit">Continue</button>
      ${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ""}
    </form>
    <p class="hint">This password protects access to your WHOOP data.</p>
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
  error?: string
): void {
  const who = clientName ? `"${clientName}"` : "An application";
  let destination = "";
  if (redirectUri) {
    try {
      destination = ` This will send your data to: ${new URL(redirectUri).host}.`;
    } catch {
      destination = "";
    }
  }
  sendPasswordPage(res, {
    action: "/auth/consent",
    title: "Authorize access",
    description: `${who} wants to connect to your WHOOP data.${destination} Enter your access password to approve.`,
    hidden: { consentId },
    error,
  });
}

const WHOOP_LINK_FORM = {
  action: "/auth/whoop",
  title: "Link your WHOOP account",
  description: "Enter your access password to link your WHOOP account.",
} as const;

export function createApp(): express.Express {
  const app = express();

  // Trust proxy (Railway runs behind a reverse proxy)
  app.set("trust proxy", 1);

  // CORS — reflect an allowlisted Origin instead of a blanket wildcard.
  // Defaults: claude.ai / claude.com + any localhost origin; CORS_ORIGINS adds more.
  const corsAllowlist = new Set([
    "https://claude.ai",
    "https://claude.com",
    ...(process.env.CORS_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  ]);
  const isAllowedOrigin = (origin: string): boolean => {
    if (corsAllowlist.has(origin)) return true;
    try {
      const { hostname } = new URL(origin);
      return hostname === "localhost" || hostname === "127.0.0.1";
    } catch {
      return false;
    }
  };

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    res.setHeader("Vary", "Origin");
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // MCP Auth Router (handles /.well-known/*, /authorize, /token, /register)
  const issuerUrl = new URL(config.server.publicUrl);

  app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
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
    if (!staticToken || !provided || !secretsMatch(provided, staticToken)) {
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

  // Consent gate — validate ACCESS_PASSWORD, then complete the pending MCP authorization.
  app.post("/auth/consent", (req: Request, res: Response) => {
    if (rejectIfRateLimited(req, res)) return;
    const body = req.body as { consentId?: unknown; password?: unknown };
    const consentId = typeof body.consentId === "string" ? body.consentId : "";
    const password = typeof body.password === "string" ? body.password : "";

    // Single use: look up and delete immediately.
    const pending = pendingConsent.get(consentId);
    if (pending) pendingConsent.delete(consentId);

    if (!pending) {
      console.error(`[auth] /auth/consent REJECTED — consentId ${consentId ? "expired/unknown" : "missing"}`);
      res.status(400).send("Consent request expired. Please restart the connection from your client.");
      return;
    }

    if (!secretsMatch(password, config.security.accessPassword)) {
      recordPwFailure(req.ip ?? "unknown");
      // Re-arm a fresh single-use consentId carrying the same pending params.
      cleanupStates();
      const freshId = randomBytes(16).toString("hex");
      pendingConsent.set(freshId, { ...pending, createdAt: Date.now() });
      console.error(`[auth] /auth/consent REJECTED — wrong password (re-armed ${freshId.slice(0, 8)}…)`);
      sendConsentPage(res, freshId, pending.clientName, pending.redirectUri, "Incorrect password. Please try again.");
      return;
    }

    resetPwAttempts(req.ip ?? "unknown");
    console.log(`[auth] /auth/consent OK — client ${pending.clientId.slice(0, 8)}… approved`);

    // If WHOOP tokens already exist, issue the MCP authorization code now.
    if (getTokens()) {
      const code = randomBytes(32).toString("hex");
      authorizationCodes.set(code, {
        clientId: pending.clientId,
        codeChallenge: pending.codeChallenge,
        redirectUri: pending.redirectUri,
        createdAt: Date.now(),
      });
      const url = new URL(pending.redirectUri);
      url.searchParams.set("code", code);
      if (pending.state) url.searchParams.set("state", pending.state);
      console.log(`[auth] Whoop tokens exist → issuing code, redirecting to client`);
      res.redirect(url.toString());
      return;
    }

    // No WHOOP tokens — chain to WHOOP OAuth, then complete MCP auth on callback.
    console.log(`[auth] No Whoop tokens → chaining to Whoop OAuth`);
    cleanupStates();
    const whoopState = randomBytes(16).toString("hex");
    pendingStates.set(whoopState, Date.now());
    pendingMcpAuth.set(whoopState, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      state: pending.state,
      codeChallenge: pending.codeChallenge,
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

  app.post("/auth/whoop", (req: Request, res: Response) => {
    if (rejectIfRateLimited(req, res)) return;
    const body = req.body as { password?: unknown };
    const password = typeof body.password === "string" ? body.password : "";
    if (!secretsMatch(password, config.security.accessPassword)) {
      recordPwFailure(req.ip ?? "unknown");
      console.error(`[auth] POST /auth/whoop REJECTED — wrong password`);
      sendPasswordPage(res, { ...WHOOP_LINK_FORM, error: "Incorrect password. Please try again." });
      return;
    }
    resetPwAttempts(req.ip ?? "unknown");
    cleanupStates();
    const state = randomBytes(16).toString("hex");
    pendingStates.set(state, Date.now());
    const whoopUrl = buildAuthUrl(state);
    sendAuthRedirectPage(res, whoopUrl);
  });

  // Whoop OAuth callback
  app.get("/auth/whoop/callback", async (req: Request, res: Response) => {
    console.log(`[callback] /auth/whoop/callback hit — query: code=${req.query.code ? "present" : "MISSING"}, state=${req.query.state ?? "MISSING"}`);
    const { code, state } = req.query;

    if (!state || typeof state !== "string" || !pendingStates.has(state)) {
      console.error(`[callback] REJECTED — state ${state ? `"${String(state).slice(0, 8)}…" not in pendingStates` : "missing"} (pendingStates size=${pendingStates.size})`);
      res.status(400).send("Invalid or expired state parameter");
      return;
    }
    pendingStates.delete(state);

    if (!code || typeof code !== "string") {
      console.error(`[callback] REJECTED — missing authorization code`);
      res.status(400).send("Missing authorization code");
      return;
    }

    try {
      console.log(`[callback] Exchanging Whoop auth code for tokens…`);
      await exchangeCodeForTokens(code);
      console.log(`[callback] Whoop tokens stored successfully`);

      // Check if this was part of a chained MCP auth flow
      const mcpAuth = pendingMcpAuth.get(state);
      console.log(`[callback] pendingMcpAuth for state ${state.slice(0, 8)}… → ${mcpAuth ? "FOUND (chained flow)" : "NOT FOUND (standalone)"}`);
      if (mcpAuth) {
        pendingMcpAuth.delete(state);

        // Complete the MCP authorization by generating a code and redirecting to Claude
        const mcpCode = randomBytes(32).toString("hex");
        authorizationCodes.set(mcpCode, {
          clientId: mcpAuth.clientId,
          codeChallenge: mcpAuth.codeChallenge,
          redirectUri: mcpAuth.redirectUri,
          createdAt: Date.now(),
        });

        const url = new URL(mcpAuth.redirectUri);
        url.searchParams.set("code", mcpCode);
        if (mcpAuth.state) url.searchParams.set("state", mcpAuth.state);

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
      console.error(`[callback] ERROR:`, err);
      if (!res.headersSent) {
        res.status(500).send("Authorization failed");
      }
    }
  });

  // Global error handler — log the detail, return a generic message.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return app;
}
