import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { useIsolatedDataDir, initTestDb } from "../helpers/db.js";

// Isolate DATA_DIR before any getDb() call (getDb reads DATA_DIR lazily).
useIsolatedDataDir("client");

import {
  exchangeCodeForTokens,
  forceRefreshAccessToken,
  getTokens,
  invalidateTokenCache,
  storeTokens,
} from "../../src/whoop/auth.js";
import { getCycles } from "../../src/whoop/client.js";
import { makeCycle } from "../helpers/fixtures.js";
import { config } from "../../src/config.js";
import { getDb } from "../../src/db/connection.js";

const WHOOP_ORIGIN = "https://api.prod.whoop.com";
const SCOPE = "read:recovery read:cycles read:sleep read:workout offline";

// --- undici mock plumbing (self-contained; does not touch shared whoopMock helper) ---

let originalDispatcher: Dispatcher | null = null;
let agent: MockAgent | undefined;

function installMock(): MockAgent {
  if (originalDispatcher === null) originalDispatcher = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return agent;
}

/** Match a WHOOP path by prefix, ignoring the (query-bearing) tail. */
const atPrefix = (prefix: string) => (path: string) => path.split("?")[0] === prefix;

const jsonHeaders = { headers: { "content-type": "application/json" } };

/** Read a request header out of undici's dispatch opts (array | object | Headers). */
function readHeader(headers: unknown, name: string): string | undefined {
  const lname = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === lname) return String(headers[i + 1]);
    }
    return undefined;
  }
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get: (n: string) => string | null }).get(name) ?? undefined;
  }
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() === lname) return String(v);
    }
  }
  return undefined;
}

beforeAll(() => {
  initTestDb();
});

beforeEach(() => {
  invalidateTokenCache(); // reset the in-memory WHOOP token cache
  // Default: a valid, far-from-expiry token so getValidAccessToken() never refreshes.
  storeTokens("valid-access-token", "valid-refresh-token", 3600, SCOPE);
});

afterEach(async () => {
  if (agent) await agent.close();
  agent = undefined;
  if (originalDispatcher) setGlobalDispatcher(originalDispatcher);
});

function abortableFetchSpy() {
  return vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    }),
  );
}

describe("WHOOP OAuth requests are time-bounded", () => {
  it("times out a hung refresh without deleting retryable credentials", async () => {
    const spy = abortableFetchSpy();
    vi.useFakeTimers();
    try {
      const refresh = forceRefreshAccessToken();
      const rejected = expect(refresh).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT", retryable: true });
      await vi.advanceTimersByTimeAsync(config.whoop.requestTimeoutMs + 1);
      await rejected;
      expect(getTokens()).not.toBeNull();
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });

  it("times out a hung authorization-code exchange", async () => {
    getDb().prepare("DELETE FROM tokens").run();
    invalidateTokenCache();
    const spy = abortableFetchSpy();
    vi.useFakeTimers();
    try {
      const exchange = exchangeCodeForTokens("test-code");
      const rejected = expect(exchange).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT", retryable: true });
      await vi.advanceTimersByTimeAsync(config.whoop.requestTimeoutMs + 1);
      await rejected;
      expect(getTokens()).toBeNull();
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });
});

describe("WHOOP client — 401 forces a real token refresh and retries with the NEW token", () => {
  it("first call 401 → refresh mints a new token → retried request carries the new bearer", async () => {
    const OLD = "whoop-access-OLD";
    const NEW = "whoop-access-NEW";
    // Seed the stale token that WHOOP will reject with 401.
    invalidateTokenCache();
    storeTokens(OLD, "whoop-refresh-OLD", 3600, SCOPE);

    const pool = installMock().get(WHOOP_ORIGIN);
    const seenBearers: Array<string | undefined> = [];

    // Data endpoint: 401 for the OLD bearer, 200 once the NEW bearer arrives.
    pool
      .intercept({ path: atPrefix("/developer/v2/cycle"), method: "GET" })
      .reply((opts) => {
        const bearer = readHeader(opts.headers, "authorization");
        seenBearers.push(bearer);
        if (bearer === `Bearer ${NEW}`) {
          return {
            statusCode: 200,
            data: { records: [makeCycle({ date: "2026-06-10", id: 1 })], next_token: null },
            responseOptions: jsonHeaders,
          };
        }
        return { statusCode: 401, data: "unauthorized", responseOptions: {} };
      })
      .persist();

    // Token refresh endpoint hands back the NEW access token.
    let refreshCalls = 0;
    pool
      .intercept({ path: "/oauth/oauth2/token", method: "POST" })
      .reply(() => {
        refreshCalls++;
        return {
          statusCode: 200,
          data: {
            access_token: NEW,
            refresh_token: "whoop-refresh-NEW",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "offline",
          },
          responseOptions: jsonHeaders,
        };
      })
      .persist();

    const cycles = await getCycles("2026-06-01T00:00:00Z", "2026-06-15T00:00:00Z");

    expect(cycles[0].id).toBe(1);
    // Exactly one refresh, exactly two data attempts: OLD (401) then NEW (200).
    expect(refreshCalls).toBe(1);
    expect(seenBearers).toEqual([`Bearer ${OLD}`, `Bearer ${NEW}`]);
    // The refreshed token is persisted for subsequent calls.
    expect(getTokens()?.accessToken).toBe(NEW);
  });

  it("surfaces the clear re-authorize error when the refresh definitively fails (400)", async () => {
    invalidateTokenCache();
    storeTokens("stale-access", "stale-refresh", 3600, SCOPE);

    const pool = installMock().get(WHOOP_ORIGIN);
    pool
      .intercept({ path: atPrefix("/developer/v2/cycle"), method: "GET" })
      .reply(401, "unauthorized")
      .persist();
    pool
      .intercept({ path: "/oauth/oauth2/token", method: "POST" })
      .reply(400, { error: "invalid_grant" }, jsonHeaders)
      .persist();

    await expect(getCycles("2026-07-01T00:00:00Z", "2026-07-15T00:00:00Z")).rejects.toThrow(/re-link/i);
  });
});

describe("WHOOP client — malformed 200 body does not crash the tool", () => {
  it("a 200 body with no records[] throws a generic upstream error, never 'records is not iterable'", async () => {
    const pool = installMock().get(WHOOP_ORIGIN);
    // Valid JSON, but the paginated shape is missing → records is undefined.
    pool
      .intercept({ path: atPrefix("/developer/v2/cycle"), method: "GET" })
      .reply(200, { error: "upstream_hiccup", message: "no records here" }, jsonHeaders)
      .persist();

    const promise = getCycles("2026-06-01T00:00:00Z", "2026-06-15T00:00:00Z");
    await expect(promise).rejects.toThrow(/unexpected response shape/i);
    await expect(promise).rejects.not.toThrow(/is not iterable/i);
  });

  it("a 200 body that is not valid JSON throws a generic 'unreadable response' error", async () => {
    const pool = installMock().get(WHOOP_ORIGIN);
    pool
      .intercept({ path: atPrefix("/developer/v2/cycle"), method: "GET" })
      .reply(200, "<html>not json</html>", { headers: { "content-type": "application/json" } })
      .persist();

    await expect(getCycles("2026-08-01T00:00:00Z", "2026-08-15T00:00:00Z")).rejects.toThrow(/unreadable response/i);
  });
});

describe("WHOOP client — pagination follows next_token across pages", () => {
  it("returns both pages' records; the second request carries nextToken + limit=25", async () => {
    const pool = installMock().get(WHOOP_ORIGIN);
    const seenPaths: string[] = [];
    const page1 = makeCycle({ date: "2026-06-10", id: 111 });
    const page2 = makeCycle({ date: "2026-06-11", id: 222 });

    pool
      .intercept({ path: atPrefix("/developer/v2/cycle"), method: "GET" })
      .reply((opts) => {
        seenPaths.push(opts.path as string);
        const query = new URLSearchParams((opts.path as string).split("?")[1] ?? "");
        if (query.get("nextToken") === "TOKEN2") {
          return { statusCode: 200, data: { records: [page2], next_token: null }, responseOptions: jsonHeaders };
        }
        return { statusCode: 200, data: { records: [page1], next_token: "TOKEN2" }, responseOptions: jsonHeaders };
      })
      .persist();

    const cycles = await getCycles("2026-06-01T00:00:00Z", "2026-06-15T00:00:00Z");

    // Both pages' records are concatenated, in order.
    expect(cycles.map((c) => c.id)).toEqual([111, 222]);
    // Exactly two round-trips.
    expect(seenPaths).toHaveLength(2);
    // First page: limit=25, no nextToken yet.
    const q1 = new URLSearchParams(seenPaths[0].split("?")[1] ?? "");
    expect(q1.get("limit")).toBe("25");
    expect(q1.get("nextToken")).toBeNull();
    // Second page: still limit=25, now carrying the next_token from page 1.
    const q2 = new URLSearchParams(seenPaths[1].split("?")[1] ?? "");
    expect(q2.get("limit")).toBe("25");
    expect(q2.get("nextToken")).toBe("TOKEN2");
  });
});
