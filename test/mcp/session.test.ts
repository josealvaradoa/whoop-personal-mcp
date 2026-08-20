import { describe, it, expect, beforeAll } from "vitest";
import request, { type Response as SupertestResponse } from "supertest";
import type { Express } from "express";
import { useIsolatedDataDir, initTestDb, seedWhoopTokens } from "../helpers/db.js";

// Isolate DATA_DIR before any getDb() call.
useIsolatedDataDir("protocol-eras");

import { createApp, oauthProvider } from "../../src/server.js";
import { mountMcp } from "../../src/mcp/setup.js";
import { config } from "../../src/config.js";
import { generatePkce, extractConsentId, parseSse } from "../helpers/http.js";
import { EXPECTED_TOOL_NAMES } from "../helpers/mcpHarness.js";

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-11-25";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const PASSWORD = config.security.accessPassword;
const ACCEPT = "application/json, text/event-stream";
const MCP_HOST = new URL(config.server.publicUrl).host;

let app: Express;
let token: string;
let requestId = 1;

async function mintDynamicToken(): Promise<string> {
  const registration = await request(app)
    .post("/register")
    .set("Content-Type", "application/json")
    .send({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Protocol Test Client",
      application_type: "web",
    });
  expect(registration.status).toBe(201);

  const clientId = registration.body.client_id as string;
  const { verifier, challenge } = generatePkce();
  const authorize = await request(app).get("/authorize").query({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "protocol-test-state",
  });
  const consentId = extractConsentId(authorize.text) as string;

  const consent = await request(app)
    .post("/auth/consent")
    .type("form")
    .send({ consentId, password: PASSWORD, wellnessConsent: "yes" });
  const code = new URL(consent.headers.location as string).searchParams.get("code") as string;

  const tokenResponse = await request(app).post("/token").type("form").send({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
  });
  expect(tokenResponse.status).toBe(200);
  return tokenResponse.body.access_token as string;
}

function envelope() {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "protocol-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function modernBody(method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: requestId++,
    method,
    params: { ...params, _meta: envelope() },
  };
}

function modernPost(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    name?: string;
    omitMethodHeader?: boolean;
    omitProtocolHeader?: boolean;
    methodHeader?: string;
    protocolHeader?: string;
    bodyOverride?: Record<string, unknown>;
  } = {},
) {
  let pending = request(app)
    .post("/mcp")
    .set("Host", MCP_HOST)
    .set("Authorization", `Bearer ${token}`)
    .set("Accept", ACCEPT)
    .set("Content-Type", "application/json");
  if (!options.omitMethodHeader) pending = pending.set("Mcp-Method", options.methodHeader ?? method);
  if (!options.omitProtocolHeader) {
    pending = pending.set("MCP-Protocol-Version", options.protocolHeader ?? MODERN_VERSION);
  }
  if (options.name) pending = pending.set("Mcp-Name", options.name);
  return pending.send(options.bodyOverride ?? modernBody(method, params));
}

function rpcMessage(response: SupertestResponse): Record<string, any> {
  if (response.body && typeof response.body === "object" && response.body.jsonrpc === "2.0") {
    return response.body as Record<string, any>;
  }
  const messages = parseSse(response.text ?? "");
  const message = messages.find((candidate) => candidate && typeof candidate === "object");
  expect(message, "response should contain one JSON-RPC message").toBeTruthy();
  return message as Record<string, any>;
}

beforeAll(async () => {
  initTestDb();
  seedWhoopTokens();
  app = createApp() as unknown as Express;
  mountMcp(app, oauthProvider);
  token = await mintDynamicToken();
  expect(token).toBeTruthy();
});

describe("MCP 2026-07-28 stateless lifecycle", () => {
  it("implements server/discover and advertises the modern revision", async () => {
    const response = await modernPost("server/discover");
    expect(response.status).toBe(200);
    expect(response.headers["mcp-session-id"]).toBeUndefined();

    const message = rpcMessage(response);
    expect(message.result.supportedVersions).toContain(MODERN_VERSION);
    expect(message.result.resultType).toBe("complete");
    expect(message.result.ttlMs).toBeTypeOf("number");
    expect(message.result.cacheScope).toBe("private");
    expect(message.result._meta?.["io.modelcontextprotocol/serverInfo"]).toMatchObject({
      name: "whoop-personal-mcp",
      version: "1.0.0",
    });
  });

  it("serves independent tools/list requests without initialize or a session id", async () => {
    const first = await modernPost("tools/list");
    const second = await modernPost("tools/list");
    const observedOrders: string[][] = [];
    for (const response of [first, second]) {
      expect(response.status).toBe(200);
      expect(response.headers["mcp-session-id"]).toBeUndefined();
      const result = rpcMessage(response).result;
      const order = result.tools.map((tool: { name: string }) => tool.name);
      observedOrders.push(order);
      expect(order).toEqual(EXPECTED_TOOL_NAMES);
      expect(result.resultType).toBe("complete");
      expect(result.ttlMs).toBe(0);
      expect(result.cacheScope).toBe("private");
    }
    expect(observedOrders[1]).toEqual(observedOrders[0]);
  });

  it("requires and validates modern standard HTTP headers", async () => {
    const missingVersion = await modernPost("tools/list", {}, { omitProtocolHeader: true });
    expect(missingVersion.status).toBe(400);
    expect(rpcMessage(missingVersion).error.code).toBe(-32020);

    const mismatchedMethod = await modernPost("tools/list", {}, { methodHeader: "prompts/list" });
    expect(mismatchedMethod.status).toBe(400);
    expect(rpcMessage(mismatchedMethod).error.code).toBe(-32020);

    const missingMethod = await modernPost("tools/list", {}, { omitMethodHeader: true });
    expect(missingMethod.status).toBe(400);
    expect(rpcMessage(missingMethod).error.code).toBe(-32020);

    const mismatchedVersion = await modernPost("tools/list", {}, { protocolHeader: LEGACY_VERSION });
    expect(mismatchedVersion.status).toBe(400);
    expect(rpcMessage(mismatchedVersion).error.code).toBe(-32020);
  });

  it("requires an exact Mcp-Name for calls whose params carry a name", async () => {
    const missingName = await modernPost("tools/call", {
      name: "whoop_get_workouts",
      arguments: { days: 1 },
    });
    expect(missingName.status).toBe(400);
    expect(rpcMessage(missingName).error.code).toBe(-32020);

    const mismatchedName = await modernPost(
      "tools/call",
      { name: "whoop_get_workouts", arguments: { days: 1 } },
      { name: "whoop_get_sleep_trend" },
    );
    expect(mismatchedName.status).toBe(400);
    expect(rpcMessage(mismatchedName).error.code).toBe(-32020);
  });

  it("preserves SDK classification for malformed requests and modern envelopes", async () => {
    const base = modernBody("tools/list") as Record<string, any>;
    const malformed = [
      { ...base, id: null },
      { ...base, jsonrpc: "1.0" },
      { ...base, method: 42 },
    ];
    for (const bodyOverride of malformed) {
      const response = await modernPost("tools/list", {}, { bodyOverride });
      expect(response.status).toBe(400);
      expect(rpcMessage(response).error.code).toBe(-32600);
    }

    const missingCapabilities = modernBody("tools/list") as Record<string, any>;
    delete missingCapabilities.params._meta["io.modelcontextprotocol/clientCapabilities"];
    const response = await modernPost("tools/list", {}, { bodyOverride: missingCapabilities });
    expect(response.status).toBe(400);
    expect(rpcMessage(response).error.code).toBe(-32602);
  });

  it("returns required completion and cache fields for prompt/resource operations", async () => {
    const operations = [
      ["prompts/list", {}, undefined],
      ["resources/list", {}, undefined],
      ["resources/templates/list", {}, undefined],
      ["resources/read", { uri: "whoop://server/usage-policy" }, "whoop://server/usage-policy"],
    ] as const;

    for (const [method, params, name] of operations) {
      const response = await modernPost(method, params, name ? { name } : {});
      expect(response.status, method).toBe(200);
      const result = rpcMessage(response).result;
      expect(result.resultType, method).toBe("complete");
      expect(result.ttlMs, method).toBeTypeOf("number");
      expect(result.cacheScope, method).toBe("private");
    }
  });

  it("does not expose the removed GET stream or DELETE session lifecycle", async () => {
    for (const method of ["get", "delete"] as const) {
      const response = await request(app)[method]("/mcp")
        .set("Host", MCP_HOST)
        .set("Authorization", `Bearer ${token}`);
      expect(response.status).toBe(405);
      expect(response.headers["mcp-session-id"]).toBeUndefined();
    }
  });
});

describe("2025-era compatibility on the same endpoint", () => {
  it("still answers a legacy initialize without creating a transport session", async () => {
    const response = await request(app)
      .post("/mcp")
      .set("Host", MCP_HOST)
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .set("Content-Type", "application/json")
      .set("MCP-Protocol-Version", LEGACY_VERSION)
      .send({
        jsonrpc: "2.0",
        id: requestId++,
        method: "initialize",
        params: {
          protocolVersion: LEGACY_VERSION,
          capabilities: {},
          clientInfo: { name: "legacy-test", version: "1.0.0" },
        },
      });

    expect(response.status).toBe(200);
    expect(response.headers["mcp-session-id"]).toBeUndefined();
    expect(rpcMessage(response).result.protocolVersion).toBe(LEGACY_VERSION);

    const list = await request(app)
      .post("/mcp")
      .set("Host", MCP_HOST)
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .set("Content-Type", "application/json")
      .set("MCP-Protocol-Version", LEGACY_VERSION)
      .send({ jsonrpc: "2.0", id: requestId++, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    expect(list.headers["mcp-session-id"]).toBeUndefined();
    expect(rpcMessage(list).result.tools).toHaveLength(EXPECTED_TOOL_NAMES.length);
  });
});
