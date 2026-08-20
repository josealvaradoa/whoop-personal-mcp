import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { getDb } from "../db/connection.js";

const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_REVOKE_URL = "https://api.prod.whoop.com/developer/v2/user/access";

// Least privilege: registered tools only use cycles, recovery, sleep and workouts.
const SCOPES = "read:recovery read:cycles read:sleep read:workout offline";

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  scope: z.string().default(""),
  token_type: z.string().optional(),
});

export type WhoopAuthErrorCode =
  | "AUTH_REQUIRED"
  | "ACCOUNT_ALREADY_LINKED"
  | "UPSTREAM_AUTH_REJECTED"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_INVALID_RESPONSE";

export class WhoopAuthError extends Error {
  constructor(
    readonly code: WhoopAuthErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WhoopAuthError";
  }
}

let cachedAccessToken: string | null = null;
let cachedExpiresAt: number | null = null;
let credentialGeneration = 0;

function deriveKey(secret: string, salt: Buffer): Buffer {
  return pbkdf2Sync(secret, salt, 100_000, 32, "sha256");
}

export function encrypt(plaintext: string, secret: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(secret, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    salt.toString("base64"),
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export function decrypt(encrypted: string, secret: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 4) throw new Error("Malformed encrypted token");
  const [saltValue, ivValue, authTagValue, ciphertextValue] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(secret, Buffer.from(saltValue, "base64")),
    Buffer.from(ivValue, "base64"),
  );
  decipher.setAuthTag(Buffer.from(authTagValue, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

/**
 * Persist the single linked account's encrypted token rotation.
 */
export function storeTokens(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  scope: string,
): void {
  const db = getDb();
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  const accessEncrypted = encrypt(accessToken, config.security.encryptionSecret);
  const refreshEncrypted = encrypt(refreshToken, config.security.encryptionSecret);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO tokens (id, access_token_encrypted, refresh_token_encrypted, expires_at, scope)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        access_token_encrypted = excluded.access_token_encrypted,
        refresh_token_encrypted = excluded.refresh_token_encrypted,
        expires_at = excluded.expires_at,
        scope = excluded.scope,
        updated_at = unixepoch()
    `).run(accessEncrypted, refreshEncrypted, expiresAt, scope);
  })();

  cachedAccessToken = accessToken;
  cachedExpiresAt = expiresAt;
}

export function getTokens(): StoredTokens | null {
  const row = getDb().prepare(`
    SELECT access_token_encrypted, refresh_token_encrypted, expires_at, scope
    FROM tokens WHERE id = 1
  `).get() as {
    access_token_encrypted: string;
    refresh_token_encrypted: string;
    expires_at: number;
    scope: string;
  } | undefined;
  if (!row) return null;

  try {
    return {
      accessToken: decrypt(row.access_token_encrypted, config.security.encryptionSecret),
      refreshToken: decrypt(row.refresh_token_encrypted, config.security.encryptionSecret),
      expiresAt: row.expires_at,
      scope: row.scope,
    };
  } catch {
    console.error("[whoop-auth] stored credentials are unreadable; treating account as unlinked");
    return null;
  }
}

function clearWhoopCredentials(): void {
  credentialGeneration++;
  cachedAccessToken = null;
  cachedExpiresAt = null;
  getDb().transaction(() => {
    getDb().prepare("DELETE FROM tokens").run();
  })();
}

let refreshPromise: Promise<string> | null = null;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function timedRequest<T>(
  url: string,
  init: RequestInit,
  handle: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.whoop.requestTimeoutMs);
  timeout.unref();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // Keep the timeout armed until the response body (when any) is consumed.
    return await handle(response);
  } catch (error) {
    if (error instanceof WhoopAuthError) throw error;
    if (isAbortError(error)) {
      throw new WhoopAuthError("UPSTREAM_TIMEOUT", "WHOOP authorization request timed out", true);
    }
    throw new WhoopAuthError("UPSTREAM_UNAVAILABLE", "WHOOP authorization service is unavailable", true);
  } finally {
    clearTimeout(timeout);
  }
}

function classifyStatus(status: number, operation: "exchange" | "refresh"): WhoopAuthError {
  if (status === 429) {
    return new WhoopAuthError("UPSTREAM_RATE_LIMITED", "WHOOP rate limited the authorization request", true, status);
  }
  if (status === 400 || status === 401 || status === 403) {
    const message = operation === "refresh"
      ? "WHOOP authorization expired. Re-link the account."
      : "WHOOP rejected the authorization request";
    return new WhoopAuthError("UPSTREAM_AUTH_REJECTED", message, false, status);
  }
  return new WhoopAuthError("UPSTREAM_UNAVAILABLE", "WHOOP authorization service returned an error", true, status);
}

async function parseTokenResponse(response: Response): Promise<z.infer<typeof TokenResponseSchema>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new WhoopAuthError("UPSTREAM_INVALID_RESPONSE", "WHOOP returned an unreadable token response", true);
  }
  const parsed = TokenResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new WhoopAuthError("UPSTREAM_INVALID_RESPONSE", "WHOOP returned an invalid token response", true);
  }
  return parsed.data;
}

async function refreshAccessToken(): Promise<string> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefreshAccessToken();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function doRefreshAccessToken(): Promise<string> {
  const tokens = getTokens();
  if (!tokens?.refreshToken) {
    throw new WhoopAuthError("AUTH_REQUIRED", "No WHOOP account is linked. Authorize at /auth/whoop", false);
  }
  const generation = credentialGeneration;
  let data: z.infer<typeof TokenResponseSchema>;
  try {
    data = await timedRequest(WHOOP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: config.whoop.clientId,
        client_secret: config.whoop.clientSecret,
        scope: "offline",
      }),
    }, async (response) => {
      if (!response.ok) {
        throw classifyStatus(response.status, "refresh");
      }
      return parseTokenResponse(response);
    });
  } catch (error) {
    if (error instanceof WhoopAuthError) {
      console.warn(`[whoop-auth] refresh failed (${error.status ?? "network"}, ${error.code})`);
      if (!error.retryable && error.code === "UPSTREAM_AUTH_REJECTED") clearWhoopCredentials();
    }
    throw error;
  }
  if (generation !== credentialGeneration) {
    throw new WhoopAuthError("AUTH_REQUIRED", "WHOOP account was disconnected during refresh", false);
  }
  storeTokens(
    data.access_token,
    data.refresh_token ?? tokens.refreshToken,
    data.expires_in,
    data.scope || tokens.scope,
  );
  return data.access_token;
}

export function invalidateTokenCache(): void {
  cachedAccessToken = null;
  cachedExpiresAt = null;
}

export async function forceRefreshAccessToken(): Promise<string> {
  return refreshAccessToken();
}

export async function getValidAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedExpiresAt && cachedExpiresAt - now > 300) return cachedAccessToken;

  const tokens = getTokens();
  if (!tokens) {
    throw new WhoopAuthError("AUTH_REQUIRED", "No WHOOP account is linked. Authorize at /auth/whoop", false);
  }
  if (tokens.expiresAt - now > 300) {
    cachedAccessToken = tokens.accessToken;
    cachedExpiresAt = tokens.expiresAt;
    return tokens.accessToken;
  }
  return refreshAccessToken();
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.whoop.clientId,
    redirect_uri: config.whoop.redirectUri,
    response_type: "code",
    scope: SCOPES,
    state,
  });
  return `${WHOOP_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<void> {
  if (getTokens()) {
    throw new WhoopAuthError(
      "ACCOUNT_ALREADY_LINKED",
      "A WHOOP account is already linked. Disconnect it before linking another account.",
      false,
    );
  }
  const generation = credentialGeneration;
  const data = await timedRequest(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: config.whoop.clientId,
      client_secret: config.whoop.clientSecret,
      redirect_uri: config.whoop.redirectUri,
    }),
  }, async (response) => {
    if (!response.ok) {
      const error = classifyStatus(response.status, "exchange");
      console.warn(`[whoop-auth] exchange failed (${response.status}, ${error.code})`);
      throw error;
    }
    return parseTokenResponse(response);
  });
  if (!data.refresh_token) {
    throw new WhoopAuthError("UPSTREAM_INVALID_RESPONSE", "WHOOP did not return an offline refresh token", true);
  }
  if (generation !== credentialGeneration || getTokens()) {
    throw new WhoopAuthError("ACCOUNT_ALREADY_LINKED", "A WHOOP account was linked concurrently", false);
  }
  storeTokens(data.access_token, data.refresh_token, data.expires_in, data.scope);
}

export interface DisconnectResult {
  revocation: "not_needed" | "succeeded" | "failed" | "unavailable";
}

/** Atomic local privacy wipe followed by best-effort remote revocation. */
export async function disconnectAndDeleteData(): Promise<DisconnectResult> {
  // Check row existence separately from decryptability. If the encryption key
  // was rotated or the row is corrupt, getTokens() correctly refuses to expose
  // credentials, but the upstream WHOOP grant may still exist and must not be
  // reported as "not needed".
  const hadStoredAccount = Boolean(
    getDb().prepare("SELECT 1 FROM tokens WHERE id = 1").get(),
  );
  const tokens = hadStoredAccount ? getTokens() : null;
  let revocation: DisconnectResult["revocation"] = hadStoredAccount
    ? "unavailable"
    : "not_needed";

  // Local privacy and authorization state is invalidated before any network
  // wait. The captured access token is used only for best-effort remote revoke;
  // a timeout, crash, or upstream outage cannot leave local bearers usable.
  credentialGeneration++;
  cachedAccessToken = null;
  cachedExpiresAt = null;
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM tokens").run();
    db.prepare("DELETE FROM mcp_access_tokens").run();
    db.prepare("DELETE FROM mcp_refresh_tokens").run();
    db.prepare("DELETE FROM mcp_clients").run();
  })();

  if (tokens) {
    revocation = "failed";
    try {
      const result = await timedRequest(WHOOP_REVOKE_URL, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }, async (response) => {
        return { ok: response.ok, status: response.status };
      });
      revocation = result.ok ? "succeeded" : "failed";
      if (!result.ok) console.warn(`[whoop-auth] remote revoke failed (${result.status}); local data will still be deleted`);
    } catch (error) {
      const code = error instanceof WhoopAuthError ? error.code : "UPSTREAM_UNAVAILABLE";
      console.warn(`[whoop-auth] remote revoke failed (${code}); local data will still be deleted`);
    }
  }

  return { revocation };
}
