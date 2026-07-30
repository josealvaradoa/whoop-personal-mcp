import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { useIsolatedDataDir, initTestDb, seedWhoopTokens, clearCache } from "../helpers/db.js";

// Isolate DATA_DIR before any getDb() call.
useIsolatedDataDir("session");

import { createApp, oauthProvider } from "../../src/server.js";
import { mountMcp } from "../../src/mcp/setup.js";
import { config } from "../../src/config.js";
import { generatePkce, extractConsentId } from "../helpers/http.js";

// Must match MAX_SESSIONS in src/mcp/setup.ts.
const MAX_SESSIONS = 10;
const WHOOP_ORIGIN = "https://api.prod.whoop.com";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const PASSWORD = config.security.accessPassword;
const ACCEPT = "application/json, text/event-stream";

let app: Express;
let token: string; // a real dynamic MCP access token (static bearer is rejected at /mcp)
let reqId = 1;
const created: string[] = []; // session ids created per test, drained in afterEach

// --- OAuth: mint one dynamic access token (mirrors test/server/auth.test.ts) ---

async function mintDynamicToken(): Promise<string> {
  const reg = await request(app)
    .post("/register")
    .set("Content-Type", "application/json")
    .send({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Session Test Client",
    });
  const clientId = reg.body.client_id as string;

  const { verifier, challenge } = generatePkce();
  const authorize = await request(app).get("/authorize").query({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "session-state",
  });
  const consentId = extractConsentId(authorize.text) as string;

  const consent = await request(app)
    .post("/auth/consent")
    .type("form")
    .send({ consentId, password: PASSWORD });
  const code = new URL(consent.headers.location as string).searchParams.get("code") as string;

  const tok = await request(app).post("/token").type("form").send({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
  });
  return tok.body.access_token as string;
}

// --- JSON-RPC bodies ---

function initBody() {
  return {
    jsonrpc: "2.0",
    id: reqId++,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "supertest", version: "1.0.0" },
    },
  };
}
const toolsListBody = () => ({ jsonrpc: "2.0", id: reqId++, method: "tools/list", params: {} });
const toolCallBody = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: reqId++,
  method: "tools/call",
  params: { name, arguments: args },
});

// --- Request helpers (non-async so callers can fire-and-track without awaiting) ---

function rawInitialize() {
  return request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${token}`)
    .set("Accept", ACCEPT)
    .set("Content-Type", "application/json")
    .send(initBody());
}

function postToSession(sid: string, body: unknown) {
  return request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${token}`)
    .set("Accept", ACCEPT)
    .set("Content-Type", "application/json")
    .set("mcp-session-id", sid)
    .send(body as object);
}

async function initSession(): Promise<string> {
  const init = await rawInitialize();
  const sid = init.headers["mcp-session-id"] as string;
  // Acknowledge initialization so the session accepts tool calls.
  await postToSession(sid, { jsonrpc: "2.0", method: "notifications/initialized" });
  created.push(sid);
  return sid;
}

/** Fire a tools/call and return its in-flight promise (does not await completion). */
function fireToolCall(sid: string, name: string, args: Record<string, unknown> = {}) {
  return postToSession(sid, toolCallBody(name, args)).then((r) => r);
}

async function drainSessions(): Promise<void> {
  for (const sid of created) {
    try {
      await request(app)
        .delete("/mcp")
        .set("Authorization", `Bearer ${token}`)
        .set("mcp-session-id", sid);
    } catch {
      /* best-effort cleanup */
    }
  }
  created.length = 0;
}

// --- Deterministic, gate-controlled WHOOP mock (no real timers) ---

let savedDispatcher: Dispatcher | null = null;
let currentAgent: MockAgent | undefined;

interface GatedMock {
  agent: MockAgent;
  release: () => void;
  waitForEntries: (n: number) => Promise<void>;
}

/**
 * Intercepts the WHOOP workout endpoint and holds every response open until
 * release() is called. waitForEntries(n) resolves once n requests have actually
 * reached the mock — i.e. n sessions are provably in flight — giving us precise,
 * timer-free control over the in-flight window.
 */
function installGatedWorkoutMock(): GatedMock {
  if (savedDispatcher === null) savedDispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  currentAgent = agent;

  let entered = 0;
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  const notify = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (entered >= waiters[i].n) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
  };
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });

  agent
    .get(WHOOP_ORIGIN)
    .intercept({ path: (p: string) => p.split("?")[0] === "/developer/v2/activity/workout", method: "GET" })
    // reply(status, dataFn) — undici awaits a Promise returned by dataFn, so the
    // response body is withheld until the gate resolves.
    .reply(
      200,
      () => {
        entered++;
        notify();
        return gate.then(() => ({ records: [], next_token: null }));
      },
      { headers: { "content-type": "application/json" } },
    )
    .persist();

  return {
    agent,
    release: () => release(),
    waitForEntries: (n: number) =>
      new Promise<void>((resolve) => {
        if (entered >= n) resolve();
        else waiters.push({ n, resolve });
      }),
  };
}

beforeAll(async () => {
  initTestDb();
  seedWhoopTokens(); // WHOOP linked → consent issues a code immediately; tools skip refresh
  app = createApp() as unknown as Express;
  mountMcp(app, oauthProvider);
  token = await mintDynamicToken();
  expect(token, "dynamic MCP token should be minted").toBeTruthy();
});

beforeEach(() => {
  clearCache();
});

afterEach(async () => {
  await drainSessions();
  if (currentAgent) {
    await currentAgent.close();
    currentAgent = undefined;
  }
  if (savedDispatcher) setGlobalDispatcher(savedDispatcher);
});

describe("MCP session lifecycle — LRU eviction", () => {
  it("evicts the oldest IDLE session when a new initialize arrives at the cap", async () => {
    const first = await initSession();
    const rest: string[] = [];
    for (let i = 0; i < MAX_SESSIONS - 1; i++) rest.push(await initSession());
    // At the cap (MAX_SESSIONS). The next initialize must evict the oldest (first).
    const extra = await initSession();

    // The oldest idle session was evicted → its id is now unknown → 404.
    expect((await postToSession(first, toolsListBody())).status).toBe(404);
    // A newer session and the freshly created one still serve requests.
    expect((await postToSession(rest[rest.length - 1], toolsListBody())).status).toBe(200);
    expect((await postToSession(extra, toolsListBody())).status).toBe(200);
  });
});

describe("MCP session lifecycle — in-flight requests are protected from eviction", () => {
  it("does NOT evict a session with an in-flight WHOOP call; evicts an idle one instead", async () => {
    const gated = installGatedWorkoutMock();

    // Session A starts a WHOOP call that blocks on the gate → A is in flight and,
    // having been created first, is the LRU (oldest) session.
    const a = await initSession();
    const aCall = fireToolCall(a, "whoop_get_workouts");
    await gated.waitForEntries(1); // A is provably mid-request now

    // Fill the remaining capacity with idle sessions (A + these === MAX_SESSIONS).
    const idle: string[] = [];
    for (let i = 0; i < MAX_SESSIONS - 1; i++) idle.push(await initSession());

    // At the cap: this initialize must SKIP in-flight A and evict the oldest idle one.
    const k = await initSession();
    expect(k, "a new session is created by evicting an idle one, not busy A").toBeTruthy();

    // Let A's WHOOP response through; its request completes normally (never torn down).
    gated.release();
    const aRes = await aCall;
    expect(aRes.status).toBe(200);

    // A survived and is still routable.
    expect((await postToSession(a, toolsListBody())).status).toBe(200);
    // The oldest IDLE session is the one that got evicted.
    expect((await postToSession(idle[0], toolsListBody())).status).toBe(404);
    // A later idle session was untouched.
    expect((await postToSession(idle[1], toolsListBody())).status).toBe(200);
  });

  it("rejects a new initialize with a 503 JSON-RPC error when EVERY session is in flight", async () => {
    const gated = installGatedWorkoutMock();

    const sids: string[] = [];
    for (let i = 0; i < MAX_SESSIONS; i++) sids.push(await initSession());
    const calls = sids.map((s) => fireToolCall(s, "whoop_get_workouts"));
    await gated.waitForEntries(MAX_SESSIONS); // all sessions provably in flight

    const res = await rawInitialize();
    expect(res.status).toBe(503);
    expect(String(res.body?.error?.message ?? "")).toMatch(/busy/i);
    expect(res.body?.jsonrpc).toBe("2.0");

    // Release everything and let the in-flight calls finish cleanly.
    gated.release();
    const results = await Promise.all(calls);
    for (const r of results) expect(r.status).toBe(200);
  });
});

describe("MCP session lifecycle — DELETE and stale sessions", () => {
  it("DELETE /mcp with no or unknown session id returns 404 cleanly", async () => {
    const noId = await request(app).delete("/mcp").set("Authorization", `Bearer ${token}`);
    expect(noId.status).toBe(404);

    const unknown = await request(app)
      .delete("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("mcp-session-id", "does-not-exist");
    expect(unknown.status).toBe(404);
  });

  it("DELETE /mcp closes a live session (200), after which it is stale (404)", async () => {
    const sid = await initSession();

    const del = await request(app)
      .delete("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("mcp-session-id", sid);
    expect(del.status).toBe(200);

    // Now stale: both a follow-up POST and a repeat DELETE see it gone.
    expect((await postToSession(sid, toolsListBody())).status).toBe(404);
    const delAgain = await request(app)
      .delete("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("mcp-session-id", sid);
    expect(delAgain.status).toBe(404);
  });

  it("POST /mcp with an unknown session id returns a JSON-RPC 404", async () => {
    const res = await postToSession("phantom-session-id", toolsListBody());
    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe(-32001);
  });
});
