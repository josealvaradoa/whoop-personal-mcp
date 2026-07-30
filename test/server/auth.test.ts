import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { useIsolatedDataDir, initTestDb, seedWhoopTokens } from "../helpers/db.js";

// Isolate DATA_DIR before any getDb() call.
const DATA_DIR = useIsolatedDataDir("auth");

import { getDb } from "../../src/db/connection.js";
import { createApp, oauthProvider } from "../../src/server.js";
import { mountMcp } from "../../src/mcp/setup.js";
import { config } from "../../src/config.js";
import { generatePkce, sha256Hex, extractConsentId, parseSse } from "../helpers/http.js";

const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const PASSWORD = config.security.accessPassword;

let app: Express;

beforeAll(() => {
  initTestDb();
  app = createApp() as unknown as Express;
  mountMcp(app, oauthProvider);
});

function clearWhoopTokens(): void {
  getDb().prepare("DELETE FROM tokens WHERE id = 1").run();
}

async function registerClient(redirectUri = REDIRECT_URI) {
  return request(app)
    .post("/register")
    .set("Content-Type", "application/json")
    .send({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Test MCP Client",
    });
}

async function getConsentId(clientId: string, challenge: string, state: string): Promise<string> {
  const res = await request(app).get("/authorize").query({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  expect(res.status).toBe(200);
  expect(res.text).toContain('type="password"');
  const consentId = extractConsentId(res.text);
  expect(consentId, "consent form should carry a consentId").toBeTruthy();
  return consentId as string;
}

describe("Dynamic client registration", () => {
  it("registers a client with an https redirect_uri", async () => {
    const res = await registerClient();
    expect(res.status).toBe(201);
    expect(res.body.client_id).toBeTruthy();
  });

  it("rejects a non-https, non-localhost redirect_uri", async () => {
    const res = await registerClient("http://evil.example.com/callback");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.client_id).toBeUndefined();
  });

  it("rejects an https redirect_uri on a non-allowed host (anti-phishing)", async () => {
    const res = await registerClient("https://evil.example/cb");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.client_id).toBeUndefined();
  });

  it("rejects a look-alike host that is not an exact match", async () => {
    for (const uri of ["https://claude.ai.evil.com/cb", "https://sub.claude.ai.evil.com/cb"]) {
      const res = await registerClient(uri);
      expect(res.status, `should reject ${uri}`).toBeGreaterThanOrEqual(400);
      expect(res.body.client_id).toBeUndefined();
    }
  });

  it("accepts an https redirect_uri on an allowed Claude host", async () => {
    const res = await registerClient("https://claude.ai/api/mcp/auth_callback");
    expect(res.status).toBe(201);
    expect(res.body.client_id).toBeTruthy();
  });
});

describe("OAuth happy path: register → authorize → consent → token → /mcp", () => {
  let accessToken: string;

  it("completes the full chained flow and issues a working access token", async () => {
    seedWhoopTokens(); // WHOOP already linked → consent issues the code immediately

    // 1. register
    const reg = await registerClient();
    expect(reg.status).toBe(201);
    const clientId = reg.body.client_id as string;

    // 2. authorize → consent form
    const { verifier, challenge } = generatePkce();
    const state = "state-happy-123";
    const consentId = await getConsentId(clientId, challenge, state);

    // 3. consent with the correct password → 302 to redirect_uri?code=…
    const consent = await request(app)
      .post("/auth/consent")
      .type("form")
      .send({ consentId, password: PASSWORD });
    expect(consent.status).toBe(302);
    const location = consent.headers.location as string;
    const redirected = new URL(location);
    expect(redirected.origin + redirected.pathname).toBe(REDIRECT_URI);
    const code = redirected.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(redirected.searchParams.get("state")).toBe(state);

    // 4. token exchange with the PKCE verifier
    const tok = await request(app).post("/token").type("form").send({
      grant_type: "authorization_code",
      code: code as string,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });
    expect(tok.status).toBe(200);
    expect(tok.body.access_token).toBeTruthy();
    expect(tok.body.token_type).toBe("Bearer");
    accessToken = tok.body.access_token as string;

    // Token-hashing: the DB stores sha256(token), never the raw token.
    const row = getDb()
      .prepare("SELECT token FROM mcp_access_tokens WHERE client_id = ?")
      .get(clientId) as { token: string } | undefined;
    expect(row, "access token row should exist").toBeTruthy();
    expect(row!.token).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.token).toBe(sha256Hex(accessToken));
    expect(row!.token).not.toBe(accessToken);
  });

  it("authenticates an /mcp initialize with the issued token and lists 7 tools", async () => {
    expect(accessToken, "previous test must have issued a token").toBeTruthy();
    const accept = "application/json, text/event-stream";

    const init = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Accept", accept)
      .set("Content-Type", "application/json")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "supertest", version: "1.0.0" },
        },
      });
    expect(init.status).toBe(200);
    const sessionId = init.headers["mcp-session-id"];
    expect(sessionId, "server should assign a session id on initialize").toBeTruthy();

    // initialized notification
    await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Accept", accept)
      .set("Content-Type", "application/json")
      .set("mcp-session-id", sessionId)
      .send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // tools/list over the established session
    const list = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Accept", accept)
      .set("Content-Type", "application/json")
      .set("mcp-session-id", sessionId)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    const msg = parseSse(list.text).find((m) => m.id === 2) as
      | { result?: { tools?: unknown[] } }
      | undefined;
    expect(msg?.result?.tools).toHaveLength(7);
  });
});

describe("Consent page transparency", () => {
  it("shows the concrete redirect_uri host so the owner sees where data goes", async () => {
    const reg = await registerClient();
    const { challenge } = generatePkce();
    const res = await request(app).get("/authorize").query({
      response_type: "code",
      client_id: reg.body.client_id as string,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-transparency",
    });
    expect(res.status).toBe(200);
    // The destination host (claude.ai) is rendered on the consent page.
    expect(res.text).toContain("This will send your data to:");
    expect(res.text).toContain(new URL(REDIRECT_URI).host); // "claude.ai"
  });
});

describe("Consent gate — negatives", () => {
  it("rejects the wrong password (re-renders the form, no redirect, no code)", async () => {
    seedWhoopTokens();
    const reg = await registerClient();
    const { challenge } = generatePkce();
    const consentId = await getConsentId(reg.body.client_id, challenge, "state-wrong-pw");

    const res = await request(app)
      .post("/auth/consent")
      .type("form")
      .send({ consentId, password: "totally-wrong-password" });

    expect(res.status).toBe(401);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain("Incorrect password");
    // A fresh single-use consentId is re-armed for the retry.
    expect(extractConsentId(res.text)).not.toBe(consentId);
  });

  it("rejects a reused (single-use) consentId", async () => {
    seedWhoopTokens();
    const reg = await registerClient();
    const { challenge } = generatePkce();
    const consentId = await getConsentId(reg.body.client_id, challenge, "state-reuse");

    const first = await request(app)
      .post("/auth/consent")
      .type("form")
      .send({ consentId, password: PASSWORD });
    expect(first.status).toBe(302); // consumes the consentId

    const second = await request(app)
      .post("/auth/consent")
      .type("form")
      .send({ consentId, password: PASSWORD });
    expect(second.status).toBe(400); // already used → expired/unknown
    expect(second.headers.location).toBeUndefined();
  });

  it("rejects an unknown consentId", async () => {
    const res = await request(app)
      .post("/auth/consent")
      .type("form")
      .send({ consentId: "deadbeef".repeat(4), password: PASSWORD });
    expect(res.status).toBe(400);
  });

  it("with no linked WHOOP account, a correct password chains to WHOOP (no code issued yet)", async () => {
    clearWhoopTokens();
    const reg = await registerClient();
    const { challenge } = generatePkce();
    const consentId = await getConsentId(reg.body.client_id, challenge, "state-chain");

    const res = await request(app)
      .post("/auth/consent")
      .type("form")
      .send({ consentId, password: PASSWORD });
    // Not a redirect-to-client: it serves the WHOOP interstitial page.
    expect(res.status).toBe(200);
    expect(res.text).toContain("api.prod.whoop.com/oauth");
    expect(res.headers.location).toBeUndefined();
  });
});

describe("Authorization code TTL", () => {
  it("rejects an expired authorization code at token exchange", async () => {
    seedWhoopTokens();
    const reg = await registerClient();
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = generatePkce();
    const consentId = await getConsentId(clientId, challenge, "state-expired");
    const consent = await request(app)
      .post("/auth/consent")
      .type("form")
      .send({ consentId, password: PASSWORD });
    expect(consent.status).toBe(302);
    const code = new URL(consent.headers.location as string).searchParams.get("code");
    expect(code).toBeTruthy();

    // Advance Date past AUTH_CODE_TTL_MS (5 min) so the code is stale at exchange.
    // Only Date is faked so express/supertest async (real timers) still works.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      const tok = await request(app).post("/token").type("form").send({
        grant_type: "authorization_code",
        code: code as string,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
      });
      expect(tok.status).toBeGreaterThanOrEqual(400);
      expect(tok.body.access_token).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("/auth/whoop — gated behind the access password", () => {
  it("GET renders a password form", async () => {
    const res = await request(app).get("/auth/whoop");
    expect(res.status).toBe(200);
    expect(res.text).toContain('type="password"');
    expect(res.text).toContain('action="/auth/whoop"');
  });

  it("POST with the wrong password is rejected", async () => {
    const res = await request(app).post("/auth/whoop").type("form").send({ password: "nope" });
    expect(res.status).toBe(401);
    expect(res.text).toContain("Incorrect password");
  });

  it("POST with the correct password proceeds to the WHOOP redirect (stops before real WHOOP)", async () => {
    const res = await request(app).post("/auth/whoop").type("form").send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.text).toContain("api.prod.whoop.com/oauth");
    expect(res.text).toContain("Connecting to WHOOP");
  });
});

describe("MCP transport — auth & session negatives", () => {
  const accept = "application/json, text/event-stream";
  let dynamicToken: string;

  beforeAll(async () => {
    // Mint a real dynamic access token (has an expiresAt → passes requireBearerAuth).
    seedWhoopTokens();
    const reg = await registerClient();
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = generatePkce();
    const consentId = await getConsentId(clientId, challenge, "state-neg");
    const consent = await request(app)
      .post("/auth/consent")
      .type("form")
      .send({ consentId, password: PASSWORD });
    const code = new URL(consent.headers.location as string).searchParams.get("code");
    const tok = await request(app).post("/token").type("form").send({
      grant_type: "authorization_code",
      code: code as string,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });
    dynamicToken = tok.body.access_token as string;
  });

  it("POST /mcp with no bearer token → 401", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Accept", accept)
      .set("Content-Type", "application/json")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(401);
  });

  it("POST /mcp with a valid token but unknown session id → 404", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${dynamicToken}`)
      .set("Accept", accept)
      .set("Content-Type", "application/json")
      .set("mcp-session-id", "nonexistent-session-id")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(404);
  });

  it("POST /mcp with a valid token, no session id, non-initialize request → 400", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${dynamicToken}`)
      .set("Accept", accept)
      .set("Content-Type", "application/json")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(400);
  });

  // FIXED: verifyAccessToken's static-bearer path now returns an AuthInfo with a
  // (perpetually-refreshed) expiresAt, so the SDK's requireBearerAuth accepts it.
  // The static MCP_BEARER_TOKEN — the documented curl/testing path — authenticates
  // /mcp and can drive a session. (Was previously 401 "Token has no expiration time".)
  it("static MCP_BEARER_TOKEN is now accepted at /mcp and can list tools", async () => {
    const staticToken = config.security.mcpBearerToken as string;
    expect(staticToken, "test env must set MCP_BEARER_TOKEN").toBeTruthy();

    const init = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${staticToken}`)
      .set("Accept", accept)
      .set("Content-Type", "application/json")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "supertest", version: "1.0.0" },
        },
      });
    expect(init.status).toBe(200);
    const sessionId = init.headers["mcp-session-id"];
    expect(sessionId, "static bearer should establish an /mcp session").toBeTruthy();

    // initialized notification
    await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${staticToken}`)
      .set("Accept", accept)
      .set("Content-Type", "application/json")
      .set("mcp-session-id", sessionId)
      .send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // tools/list over the established session
    const list = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${staticToken}`)
      .set("Accept", accept)
      .set("Content-Type", "application/json")
      .set("mcp-session-id", sessionId)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    const msg = parseSse(list.text).find((m) => m.id === 2) as
      | { result?: { tools?: unknown[] } }
      | undefined;
    expect(msg?.result?.tools).toHaveLength(7);
  });
});

// Kept last: the per-IP failed-attempt counter is process-wide, so locking out the
// (shared) test IP here must not precede other password tests in this file.
describe("Password rate limiting on password endpoints", () => {
  it("locks out an IP after 5 failed password attempts (429 + Retry-After)", async () => {
    // 5 wrong passwords are allowed (each rejected with 401)…
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post("/auth/whoop")
        .type("form")
        .send({ password: "definitely-wrong-guess" });
      expect(r.status, `attempt ${i + 1} should be 401`).toBe(401);
    }
    // …the 6th from the same IP is rate-limited.
    const blocked = await request(app)
      .post("/auth/whoop")
      .type("form")
      .send({ password: "definitely-wrong-guess" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeTruthy();

    // A correct password is also blocked while the lockout window is active.
    const correctButLocked = await request(app)
      .post("/auth/whoop")
      .type("form")
      .send({ password: PASSWORD });
    expect(correctButLocked.status).toBe(429);
  });
});
