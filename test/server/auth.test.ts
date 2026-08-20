import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { useIsolatedDataDir, initTestDb, seedWhoopTokens } from "../helpers/db.js";

// Isolate DATA_DIR before any getDb() call.
const DATA_DIR = useIsolatedDataDir("auth");

import { getDb } from "../../src/db/connection.js";
import { createApp, oauthProvider } from "../../src/server.js";
import { mountMcp } from "../../src/mcp/setup.js";
import { config } from "../../src/config.js";
import { buildAuthUrl, getTokens } from "../../src/whoop/auth.js";
import { generatePkce, sha256Hex, extractConsentId, parseSse } from "../helpers/http.js";
import { EXPECTED_TOOL_NAMES } from "../helpers/mcpHarness.js";

const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const PASSWORD = config.security.accessPassword;
const MCP_HOST = new URL(config.server.publicUrl).host;
const MODERN_VERSION = "2026-07-28";

let app: Express;
let reusableClientId: string;

function modernRequest(method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "auth-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

function parseRpcResponse(response: { body: unknown; text: string }): any {
  if (response.body && typeof response.body === "object" &&
      (response.body as { jsonrpc?: string }).jsonrpc === "2.0") {
    return response.body;
  }
  return parseSse(response.text).find((message) => message && typeof message === "object");
}

beforeAll(() => {
  initTestDb();
  app = createApp() as unknown as Express;
  mountMcp(app, oauthProvider);
});

function clearWhoopTokens(): void {
  getDb().prepare("DELETE FROM tokens WHERE id = 1").run();
}

describe("OAuth protected-resource discovery", () => {
  it("publishes path-specific metadata for the /mcp resource", async () => {
    const res = await request(app).get("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe(`${config.server.publicUrl}/mcp`);
    expect(res.body.authorization_servers).toContain(`${config.server.publicUrl}/`);
    expect(res.body.scopes_supported).toEqual(["mcp:read"]);
  });

  it("advertises the 2026 authorization capabilities while retaining DCR fallback", async () => {
    const res = await request(app).get("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      issuer: `${config.server.publicUrl}/`,
      registration_endpoint: `${config.server.publicUrl}/register`,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ["mcp:read"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("points unauthenticated MCP clients to the protected-resource metadata", async () => {
    const res = await request(app).get("/mcp").set("Host", MCP_HOST);
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain(
      `resource_metadata="${config.server.publicUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(res.headers["www-authenticate"]).toContain('error="invalid_token"');
    expect(res.headers["www-authenticate"]).toContain('scope="mcp:read"');
  });

  it("rejects a valid bearer that lacks the required mcp:read scope", async () => {
    const scopedApp = createApp() as unknown as Express;
    const verifier: OAuthTokenVerifier = {
      async verifyAccessToken(token) {
        return {
          token,
          clientId: "scope-negative-test",
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        };
      },
    };
    mountMcp(scopedApp, verifier);

    const res = await request(scopedApp)
      .post("/mcp")
      .set("Host", MCP_HOST)
      .set("Authorization", "Bearer valid-but-scopeless")
      .set("Accept", "application/json, text/event-stream")
      .set("Content-Type", "application/json")
      .set("MCP-Protocol-Version", MODERN_VERSION)
      .set("Mcp-Method", "server/discover")
      .send(modernRequest("server/discover"));
    expect(res.status).toBe(403);
    expect(res.headers["www-authenticate"]).toContain('error="insufficient_scope"');
    expect(res.headers["www-authenticate"]).toContain('scope="mcp:read"');
  });
});

async function registerClient(redirectUri = REDIRECT_URI, clientName = "Test MCP Client") {
  return request(app)
    .post("/register")
    .set("Content-Type", "application/json")
    .send({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: clientName,
      application_type: "web",
    });
}

async function getConsentId(
  clientId: string,
  challenge: string,
  state: string,
  options: { scope?: string; resource?: string } = {},
): Promise<string> {
  const query: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  };
  if (options.scope) query.scope = options.scope;
  if (options.resource) query.resource = options.resource;
  const res = await request(app).get("/authorize").query(query);
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

  it("accepts an https redirect_uri on an explicitly allowlisted remote host", async () => {
    const res = await registerClient("https://claude.ai/api/mcp/auth_callback");
    expect(res.status).toBe(201);
    expect(res.body.client_id).toBeTruthy();
  });

  it("rejects oversized unauthenticated registration bodies", async () => {
    const res = await registerClient(`https://claude.ai/${"x".repeat(70_000)}`);
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
  });

  it("purges stale unissued registrations before enforcing the storage cap", async () => {
    const db = getDb();
    const staleAt = Math.floor(Date.now() / 1000) - 11 * 60;
    const insert = db.prepare("INSERT OR REPLACE INTO mcp_clients (client_id, client_info, created_at) VALUES (?, ?, ?)");
    db.transaction(() => {
      for (let i = 0; i < 100; i++) {
        insert.run(`stale-unissued-${i}`, JSON.stringify({ client_id: `stale-unissued-${i}` }), staleAt);
      }
      insert.run("stale-issued", JSON.stringify({ client_id: "stale-issued" }), staleAt);
      db.prepare("INSERT OR REPLACE INTO mcp_access_tokens (token, client_id, expires_at) VALUES (?, ?, ?)")
        .run("issued-token-hash", "stale-issued", Math.floor(Date.now() / 1000) + 3600);
    })();

    const res = await registerClient();
    expect(res.status).toBe(201);
    const stale = db.prepare("SELECT COUNT(*) AS count FROM mcp_clients WHERE client_id LIKE 'stale-unissued-%'")
      .get() as { count: number };
    expect(stale.count).toBe(0);
    expect(db.prepare("SELECT 1 FROM mcp_clients WHERE client_id = 'stale-issued'").get()).toBeTruthy();
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
    reusableClientId = clientId;

    // 2. authorize → consent form
    const { verifier, challenge } = generatePkce();
    const state = "state-happy-123";
    const consentId = await getConsentId(clientId, challenge, state);

    // 3. consent with the correct password → 302 to redirect_uri?code=…
    const consent = await request(app)
      .post("/auth/consent")
      .type("form")
      .send({ consentId, password: PASSWORD, wellnessConsent: "yes" });
    expect(consent.status).toBe(302);
    const location = consent.headers.location as string;
    const redirected = new URL(location);
    expect(redirected.origin + redirected.pathname).toBe(REDIRECT_URI);
    const code = redirected.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(redirected.searchParams.get("state")).toBe(state);
    expect(redirected.searchParams.get("iss")).toBe(`${config.server.publicUrl}/`);

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
    expect(tok.body.scope).toBe("mcp:read");
    expect(tok.body.refresh_token).toBeTruthy();
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

  it("authenticates a stateless MCP 2026-07-28 request with the issued token", async () => {
    expect(accessToken, "previous test must have issued a token").toBeTruthy();
    const accept = "application/json, text/event-stream";

    const list = await request(app)
      .post("/mcp")
      .set("Host", MCP_HOST)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Accept", accept)
      .set("Content-Type", "application/json")
      .set("MCP-Protocol-Version", MODERN_VERSION)
      .set("Mcp-Method", "tools/list")
      .send(modernRequest("tools/list"));
    expect(list.status).toBe(200);
    expect(list.headers["mcp-session-id"]).toBeUndefined();
    const message = parseRpcResponse(list) as {
      result?: { tools?: unknown[]; resultType?: string };
    };
    expect(message?.result?.tools).toHaveLength(EXPECTED_TOOL_NAMES.length);
    expect(message?.result?.resultType).toBe("complete");
  });
});

describe("OAuth scope, resource, and issuer binding", () => {
  it("binds an explicitly requested MCP resource through the token exchange", async () => {
    seedWhoopTokens();
    expect(reusableClientId, "happy-path setup should create the reusable client").toBeTruthy();
    const clientId = reusableClientId;
    const { verifier, challenge } = generatePkce();
    const resource = `${config.server.publicUrl}/mcp`;
    const consentId = await getConsentId(clientId, challenge, "state-resource-bound", {
      scope: "mcp:read",
      resource,
    });
    const consent = await request(app).post("/auth/consent").type("form")
      .send({ consentId, password: PASSWORD, wellnessConsent: "yes" });
    const code = new URL(consent.headers.location as string).searchParams.get("code") as string;

    const missing = await request(app).post("/token").type("form").send({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("invalid_target");

    const mismatch = await request(app).post("/token").type("form").send({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: `${config.server.publicUrl}/not-mcp`,
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toBe("invalid_target");

    const accepted = await request(app).post("/token").type("form").send({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.scope).toBe("mcp:read");
  });

  it("returns OAuth errors with state and RFC 9207 issuer on the client redirect", async () => {
    expect(reusableClientId, "happy-path setup should create the reusable client").toBeTruthy();
    const clientId = reusableClientId;
    const { challenge } = generatePkce();

    for (const [state, extra, expectedError] of [
      ["state-invalid-target", { resource: `${config.server.publicUrl}/not-mcp` }, "invalid_target"],
      ["state-invalid-scope", { scope: "mcp:write" }, "invalid_scope"],
    ] as const) {
      const res = await request(app).get("/authorize").query({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        ...extra,
      });
      expect(res.status).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect(location.searchParams.get("error")).toBe(expectedError);
      expect(location.searchParams.get("state")).toBe(state);
      expect(location.searchParams.get("iss")).toBe(`${config.server.publicUrl}/`);
    }
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
    expect(res.text).toMatch(/receive, process, and potentially retain/i);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
  });

  it("escapes an untrusted registered client name", async () => {
    const clientName = `</span><script>globalThis.compromised=true</script>`;
    const reg = await registerClient(REDIRECT_URI, clientName);
    const { challenge } = generatePkce();
    const res = await request(app).get("/authorize").query({
      response_type: "code",
      client_id: reg.body.client_id as string,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-html-escape",
    });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(clientName);
    expect(res.text).toContain("&lt;script&gt;");
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
      .send({ consentId, password: "totally-wrong-password", wellnessConsent: "yes" });

    expect(res.status).toBe(401);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toMatch(/correct password/i);
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
      .send({ consentId, password: PASSWORD, wellnessConsent: "yes" });
    expect(first.status).toBe(302); // consumes the consentId

    const second = await request(app)
      .post("/auth/consent")
      .type("form")
      .send({ consentId, password: PASSWORD, wellnessConsent: "yes" });
    expect(second.status).toBe(400); // already used → expired/unknown
    expect(second.headers.location).toBeUndefined();
  });

  it("rejects an unknown consentId", async () => {
    const res = await request(app)
      .post("/auth/consent")
      .type("form")
      .send({ consentId: "deadbeef".repeat(4), password: PASSWORD, wellnessConsent: "yes" });
    expect(res.status).toBe(400);
  });

  it("requires an explicit wellness-only acknowledgment before issuing a code", async () => {
    seedWhoopTokens();
    const reg = await registerClient();
    const { challenge } = generatePkce();
    const consentId = await getConsentId(reg.body.client_id, challenge, "state-no-ack");
    const res = await request(app).post("/auth/consent").type("form")
      .send({ consentId, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toMatch(/acknowledge/i);
  });

  it("rejects a consent request after its ten-minute TTL at consumption", async () => {
    seedWhoopTokens();
    const reg = await registerClient();
    const { challenge } = generatePkce();
    const consentId = await getConsentId(reg.body.client_id, challenge, "state-stale-consent");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      const res = await request(app).post("/auth/consent").type("form")
        .send({ consentId, password: PASSWORD, wellnessConsent: "yes" });
      expect(res.status).toBe(400);
      expect(res.headers.location).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("with no linked WHOOP account, a correct password chains to WHOOP (no code issued yet)", async () => {
    clearWhoopTokens();
    const reg = await registerClient();
    const { challenge } = generatePkce();
    const consentId = await getConsentId(reg.body.client_id, challenge, "state-chain");

    const res = await request(app)
      .post("/auth/consent")
      .type("form")
      .send({ consentId, password: PASSWORD, wellnessConsent: "yes" });
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
      .send({ consentId, password: PASSWORD, wellnessConsent: "yes" });
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

  it("binds the PKCE challenge to the client that received the code", async () => {
    seedWhoopTokens();
    const ownerRegistration = await registerClient();
    const otherRegistration = await registerClient();
    const { challenge } = generatePkce();
    const consentId = await getConsentId(ownerRegistration.body.client_id as string, challenge, "state-client-bound");
    const consent = await request(app).post("/auth/consent").type("form")
      .send({ consentId, password: PASSWORD, wellnessConsent: "yes" });
    const code = new URL(consent.headers.location as string).searchParams.get("code") as string;
    const ownerClient = await oauthProvider.clientsStore.getClient(ownerRegistration.body.client_id as string);
    const otherClient = await oauthProvider.clientsStore.getClient(otherRegistration.body.client_id as string);
    expect(ownerClient).toBeTruthy();
    expect(otherClient).toBeTruthy();

    await expect(oauthProvider.challengeForAuthorizationCode(otherClient!, code)).rejects.toThrow(/invalid/i);
    await expect(oauthProvider.challengeForAuthorizationCode(ownerClient!, code)).resolves.toBe(challenge);
  });
});

describe("WHOOP OAuth state and least-privilege scopes", () => {
  it("requests only scopes used by registered tools", () => {
    const scopes = new Set(new URL(buildAuthUrl("test-state")).searchParams.get("scope")?.split(" "));
    expect(scopes).toEqual(new Set(["read:recovery", "read:cycles", "read:sleep", "read:workout", "offline"]));
    expect(scopes.has("read:profile")).toBe(false);
    expect(scopes.has("read:body_measurement")).toBe(false);
  });

  it("rejects a WHOOP callback after state expiry before exchanging its code", async () => {
    clearWhoopTokens();
    const start = await request(app).post("/auth/whoop").type("form")
      .send({ password: PASSWORD, wellnessConsent: "yes" });
    const state = start.text.replaceAll("&amp;", "&").match(/[?&]state=([0-9a-f]{32})/)?.[1];
    expect(state).toBeTruthy();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      const callback = await request(app).get("/auth/whoop/callback").query({ state, code: "unused-code" });
      expect(callback.status).toBe(400);
      expect(getTokens()).toBeNull();
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
    expect(res.text).toContain('name="wellnessConsent"');
    expect(res.text).toMatch(/not medical care/i);
    expect(res.text).toMatch(/I confirm this is my WHOOP account/i);
    expect(res.text).toMatch(/only to clients I later explicitly authorize/i);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("POST with the wrong password is rejected", async () => {
    const res = await request(app).post("/auth/whoop").type("form").send({ password: "nope", wellnessConsent: "yes" });
    expect(res.status).toBe(401);
    expect(res.text).toMatch(/correct password/i);
  });

  it("POST with the correct password proceeds to the WHOOP redirect (stops before real WHOOP)", async () => {
    clearWhoopTokens();
    const res = await request(app).post("/auth/whoop").type("form").send({ password: PASSWORD, wellnessConsent: "yes" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("api.prod.whoop.com/oauth");
    expect(res.text).toContain("Connecting to WHOOP");
    expect(res.text).not.toContain("<script");
  });

  it("requires the wellness-only acknowledgment and refuses account replacement", async () => {
    clearWhoopTokens();
    const missingAck = await request(app).post("/auth/whoop").type("form").send({ password: PASSWORD });
    expect(missingAck.status).toBe(401);
    expect(missingAck.text).toMatch(/acknowledge/i);

    seedWhoopTokens();
    const replacement = await request(app).post("/auth/whoop").type("form")
      .send({ password: PASSWORD, wellnessConsent: "yes" });
    expect(replacement.status).toBe(409);
  });
});

describe("MCP transport — auth and modern-protocol negatives", () => {
  const accept = "application/json, text/event-stream";
  let dynamicToken: string;

  beforeAll(async () => {
    // Mint a real dynamic access token (has an expiresAt → passes requireBearerAuth).
    seedWhoopTokens();
    const reg = await registerClient();
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = generatePkce();
    const consentId = await getConsentId(clientId, challenge, "state-neg");
    const consent = await request(app)
      .post("/auth/consent")
      .type("form")
      .send({ consentId, password: PASSWORD, wellnessConsent: "yes" });
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
      .set("Host", MCP_HOST)
      .set("Accept", accept)
      .set("Content-Type", "application/json")
      .send(modernRequest("server/discover"));
    expect(res.status).toBe(401);
  });

  it("rejects disallowed/malformed Origin and Host before MCP authentication", async () => {
    const body = modernRequest("server/discover");
    const disallowed = await request(app).post("/mcp").set("Host", MCP_HOST).set("Origin", "https://evil.example")
      .set("Content-Type", "application/json").send(body);
    expect(disallowed.status).toBe(403);
    expect(disallowed.body.error.code).toBe("ORIGIN_NOT_ALLOWED");

    const malformed = await request(app).post("/mcp").set("Host", MCP_HOST).set("Origin", "not an origin")
      .set("Content-Type", "application/json").send(body);
    expect(malformed.status).toBe(403);

    const badHost = await request(app).post("/mcp").set("Host", "evil.example")
      .set("Content-Type", "application/json").send(body);
    expect(badHost.status).toBe(421);
    expect(badHost.body.error.code).toBe("HOST_NOT_ALLOWED");

    const trailingOrigin = await request(app).post("/mcp/").set("Host", MCP_HOST).set("Origin", "https://evil.example")
      .set("Content-Type", "application/json").send(body);
    expect(trailingOrigin.status).toBe(403);
    expect(trailingOrigin.body.error.code).toBe("ORIGIN_NOT_ALLOWED");

    const trailingHost = await request(app).post("/mcp/").set("Host", "evil.example")
      .set("Content-Type", "application/json").send(body);
    expect(trailingHost.status).toBe(421);
    expect(trailingHost.body.error.code).toBe("HOST_NOT_ALLOWED");

    const allowed = await request(app).post("/mcp").set("Host", MCP_HOST).set("Origin", "https://claude.ai")
      .set("Content-Type", "application/json").send(body);
    expect(allowed.status).toBe(401);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://claude.ai");
    expect(allowed.headers["access-control-allow-headers"]).toMatch(/MCP-Protocol-Version/);
    expect(allowed.headers["access-control-allow-headers"]).toMatch(/Mcp-Method/);
    expect(allowed.headers["access-control-allow-headers"]).toMatch(/Mcp-Name/);
    expect(allowed.headers["access-control-expose-headers"]).toMatch(/WWW-Authenticate/i);
    expect(allowed.headers["www-authenticate"]).toContain("resource_metadata=");
  });

  it("POST /mcp with a modern envelope but no standard protocol headers → 400", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Host", MCP_HOST)
      .set("Authorization", `Bearer ${dynamicToken}`)
      .set("Accept", accept)
      .set("Content-Type", "application/json")
      .send(modernRequest("tools/list"));
    expect(res.status).toBe(400);
    expect(parseRpcResponse(res).error.code).toBe(-32020);
  });

  // FIXED: verifyAccessToken's static-bearer path now returns an AuthInfo with a
  // (perpetually-refreshed) expiresAt, so the SDK's requireBearerAuth accepts it.
  // The static MCP_BEARER_TOKEN — the documented curl/testing path — authenticates
  // /mcp and can drive modern stateless calls. (Was previously 401 "Token has no expiration time".)
  it("static MCP_BEARER_TOKEN is accepted by modern stateless /mcp calls", async () => {
    const staticToken = config.security.mcpBearerToken as string;
    expect(staticToken, "test env must set MCP_BEARER_TOKEN").toBeTruthy();

    const list = await request(app)
      .post("/mcp")
      .set("Host", MCP_HOST)
      .set("Authorization", `Bearer ${staticToken}`)
      .set("Accept", accept)
      .set("Content-Type", "application/json")
      .set("MCP-Protocol-Version", MODERN_VERSION)
      .set("Mcp-Method", "tools/list")
      .send(modernRequest("tools/list"));
    expect(list.status).toBe(200);
    expect(list.headers["mcp-session-id"]).toBeUndefined();
    const message = parseRpcResponse(list) as { result?: { tools?: unknown[] } };
    expect(message?.result?.tools).toHaveLength(EXPECTED_TOOL_NAMES.length);
  });
});

describe("protected disconnect and privacy wipe", () => {
  it("revokes WHOOP and atomically removes local WHOOP and MCP authorization state", async () => {
    seedWhoopTokens();
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO mcp_clients (client_id, client_info) VALUES (?, ?)")
      .run("wipe-client", JSON.stringify({ client_id: "wipe-client", redirect_uris: [REDIRECT_URI] }));
    db.prepare("INSERT OR REPLACE INTO mcp_access_tokens (token, client_id, expires_at) VALUES (?, ?, ?)")
      .run("hashed-access", "wipe-client", Math.floor(Date.now() / 1000) + 60);
    db.prepare("INSERT OR REPLACE INTO mcp_refresh_tokens (token, client_id, expires_at) VALUES (?, ?, ?)")
      .run("hashed-refresh", "wipe-client", Math.floor(Date.now() / 1000) + 60);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const res = await request(app).post("/auth/disconnect")
        .set("Authorization", `Bearer ${config.security.mcpBearerToken as string}`)
        .send({ access_password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "disconnected",
        local_data_deleted: true,
        whoop_revocation: "succeeded",
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.prod.whoop.com/developer/v2/user/access",
        expect.objectContaining({ method: "DELETE" }),
      );
      for (const table of ["tokens", "mcp_clients", "mcp_access_tokens", "mcp_refresh_tokens"]) {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
        expect(row.count, `${table} should be empty`).toBe(0);
      }
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cache'").get()).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects an unauthenticated privacy wipe", async () => {
    const res = await request(app).post("/auth/disconnect");
    expect(res.status).toBe(401);
  });

  it("rejects a read bearer without separate owner confirmation", async () => {
    const res = await request(app).post("/auth/disconnect")
      .set("Authorization", `Bearer ${config.security.mcpBearerToken as string}`);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("OWNER_CONFIRMATION_REQUIRED");
  });

  it("requires manual WHOOP revocation when a stored token row is unreadable", async () => {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO tokens
        (id, access_token_encrypted, refresh_token_encrypted, expires_at, scope)
      VALUES (1, ?, ?, ?, ?)
    `).run("corrupt", "corrupt", Math.floor(Date.now() / 1000) + 3600, "offline");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await request(app).post("/auth/disconnect")
        .set("Authorization", `Bearer ${config.security.mcpBearerToken as string}`)
        .send({ access_password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "disconnected",
        local_data_deleted: true,
        whoop_revocation: "unavailable",
        manual_whoop_revocation_required: true,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(db.prepare("SELECT 1 FROM tokens WHERE id = 1").get()).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("invalidates local credentials before a slow WHOOP revoke resolves", async () => {
    seedWhoopTokens();
    const db = getDb();
    const dynamicToken = "dynamic-token-that-must-be-invalidated-immediately";
    db.prepare("INSERT OR REPLACE INTO mcp_clients (client_id, client_info) VALUES (?, ?)")
      .run("slow-wipe-client", JSON.stringify({ client_id: "slow-wipe-client" }));
    db.prepare("INSERT OR REPLACE INTO mcp_access_tokens (token, client_id, expires_at) VALUES (?, ?, ?)")
      .run(sha256Hex(dynamicToken), "slow-wipe-client", Math.floor(Date.now() / 1000) + 3600);

    let revokeStarted!: () => void;
    let releaseRevoke!: () => void;
    const started = new Promise<void>((resolve) => { revokeStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseRevoke = resolve; });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      revokeStarted();
      await gate;
      return new Response(null, { status: 204 });
    });

    try {
      const responsePromise = request(app).post("/auth/disconnect")
        .set("Authorization", `Bearer ${config.security.mcpBearerToken as string}`)
        .send({ access_password: PASSWORD })
        .then((response) => response);
      await started;

      for (const table of ["tokens", "mcp_clients", "mcp_access_tokens", "mcp_refresh_tokens"]) {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
        expect(row.count, `${table} should be empty before remote revoke resolves`).toBe(0);
      }
      await expect(oauthProvider.verifyAccessToken(dynamicToken)).rejects.toBeDefined();

      releaseRevoke();
      const res = await responsePromise;
      expect(res.status).toBe(200);
      expect(res.body.whoop_revocation).toBe("succeeded");
    } finally {
      releaseRevoke();
      fetchSpy.mockRestore();
    }
  });
});

describe("Request-volume rate limiting on expensive auth routes", () => {
  it("caps repeated WHOOP callback requests and publishes retry guidance", async () => {
    const limitedApp = createApp() as unknown as Express;

    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await request(limitedApp)
        .get("/auth/whoop/callback")
        .query({ state: "invalid-state", code: "unused-code" });
      expect(response.status, `callback attempt ${attempt + 1} should reach the handler`).toBe(400);
      expect(response.headers.ratelimit).toBeTruthy();
    }

    const blocked = await request(limitedApp)
      .get("/auth/whoop/callback")
      .query({ state: "invalid-state", code: "unused-code" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeTruthy();
  });
});

// Kept last: the per-IP failed-attempt counter is process-wide, so locking out the
// (shared) test IP here must not precede other password tests in this file.
describe("Password rate limiting on password endpoints", () => {
  it("shares a five-failure lockout across disconnect and browser password endpoints", async () => {
    const disconnectFailure = await request(app).post("/auth/disconnect")
      .set("Authorization", `Bearer ${config.security.mcpBearerToken as string}`)
      .send({ access_password: "definitely-wrong-guess" });
    expect(disconnectFailure.status).toBe(403);

    // Four more wrong passwords are allowed (each rejected with 401)…
    for (let i = 0; i < 4; i++) {
      const r = await request(app)
        .post("/auth/whoop")
        .type("form")
        .send({ password: "definitely-wrong-guess", wellnessConsent: "yes" });
      expect(r.status, `browser attempt ${i + 1} should be 401`).toBe(401);
    }
    // …the next request from the same IP is rate-limited.
    const blocked = await request(app)
      .post("/auth/whoop")
      .type("form")
      .send({ password: "definitely-wrong-guess", wellnessConsent: "yes" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeTruthy();

    // A correct password is also blocked while the lockout window is active.
    const correctButLocked = await request(app)
      .post("/auth/whoop")
      .type("form")
      .send({ password: PASSWORD, wellnessConsent: "yes" });
    expect(correctButLocked.status).toBe(429);
  });
});
