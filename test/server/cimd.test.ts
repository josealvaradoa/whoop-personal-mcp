import { EventEmitter } from "node:events";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { useIsolatedDataDir, initTestDb } from "../helpers/db.js";
import { generatePkce, extractConsentId } from "../helpers/http.js";

useIsolatedDataDir("cimd");

const mocks = vi.hoisted(() => ({
  dnsLookup: vi.fn(),
  httpsRequest: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({ lookup: mocks.dnsLookup }));
vi.mock("node:https", () => ({ request: mocks.httpsRequest }));

const { createApp } = await import("../../src/server.js");
const { config } = await import("../../src/config.js");
const mockedHttpsModule = await import("node:https");

const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const CLIENT_ID = "https://metadata.example/mcp-client.json";

interface FakeResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
  resume: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

interface FakeRequest extends EventEmitter {
  setTimeout: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function queueCimdResponse(
  body: unknown,
  headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "public, max-age=60",
  },
  requestedClientId = CLIENT_ID,
  statusCode = 200,
): void {
  const requestedUrl = new URL(requestedClientId);
  mocks.httpsRequest.mockImplementationOnce((options: Record<string, unknown>, callback: (res: FakeResponse) => void) => {
    const req = new EventEmitter() as FakeRequest;
    req.setTimeout = vi.fn();
    req.destroy = vi.fn((error?: Error) => {
      if (error) req.emit("error", error);
    });
    req.end = vi.fn(() => {
      queueMicrotask(() => {
        const response = new EventEmitter() as FakeResponse;
        response.statusCode = statusCode;
        response.headers = headers;
        response.resume = vi.fn();
        response.destroy = vi.fn();
        callback(response);
        queueMicrotask(() => {
          response.emit("data", Buffer.from(JSON.stringify(body)));
          response.emit("end");
        });
      });
    });

    expect(options).toMatchObject({
      protocol: "https:",
      hostname: requestedUrl.hostname,
      path: requestedUrl.pathname,
      method: "GET",
      servername: requestedUrl.hostname,
    });
    expect(typeof options.lookup).toBe("function");
    (options.lookup as Function)(requestedUrl.hostname, {}, (
      error: Error | null,
      address: string,
      family: number,
    ) => {
      expect(error).toBeNull();
      expect(address).toBe("8.8.8.8");
      expect(family).toBe(4);
    });
    return req;
  });
}

function validCimd(clientId = CLIENT_ID) {
  return {
    client_id: clientId,
    client_name: "CIMD Test Client",
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    application_type: "web",
  };
}

async function authorize(app: Express, clientId = CLIENT_ID) {
  const { challenge } = generatePkce();
  return request(app).get("/authorize").query({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "cimd-test-state",
    scope: "mcp:read",
    resource: `${config.server.publicUrl}/mcp`,
  });
}

let app: Express;

beforeAll(() => {
  initTestDb();
  app = createApp() as unknown as Express;
});

beforeEach(() => {
  mocks.dnsLookup.mockReset();
  mocks.httpsRequest.mockReset();
});

describe("MCP 2026-07-28 Client ID Metadata Documents", () => {
  it("resolves a public HTTPS client document without dynamic registration", async () => {
    expect(mockedHttpsModule.request).toBe(mocks.httpsRequest);
    mocks.dnsLookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    queueCimdResponse(validCimd());

    const first = await authorize(app);
    expect(mocks.dnsLookup).toHaveBeenCalledTimes(1);
    expect(mocks.httpsRequest).toHaveBeenCalledTimes(1);
    expect(first.status).toBe(200);
    expect(extractConsentId(first.text)).toBeTruthy();
    expect(first.text).toContain("CIMD Test Client");
    expect(first.text).toContain("metadata.example");
    expect(first.text).toContain("claude.ai");

    // max-age allows the second authorization to use the bounded in-memory
    // metadata cache rather than dereference the client_id again.
    const second = await authorize(app);
    expect(second.status).toBe(200);
    expect(mocks.dnsLookup).toHaveBeenCalledTimes(1);
    expect(mocks.httpsRequest).toHaveBeenCalledTimes(1);
  });

  it("blocks private, mixed public/private, and non-HTTPS client identifiers before connection", async () => {
    for (const answers of [
      [{ address: "127.0.0.1", family: 4 }],
      [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.2", family: 4 },
      ],
      [{ address: "::ffff:7f00:1", family: 6 }],
    ]) {
      mocks.dnsLookup.mockResolvedValueOnce(answers);
      const res = await authorize(app, `https://blocked-${answers.length}.example/client.json`);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }

    for (const clientId of [
      "http://metadata.example/client.json",
      "https://metadata.example/",
      "https://metadata.example/client.json?tenant=secret",
    ]) {
      const res = await authorize(app, clientId);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it("rejects a document whose declared client_id does not exactly match the requested URL", async () => {
    const requestedClientId = "https://bad-metadata.example/mcp-client.json";
    mocks.dnsLookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    queueCimdResponse(validCimd("https://metadata.example/different.json"), {
      "content-type": "application/json",
      "cache-control": "no-store",
    }, requestedClientId);

    const res = await authorize(app, requestedClientId);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(extractConsentId(res.text)).toBeNull();
    expect(mocks.httpsRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe metadata redirects, response redirects, content types, and sizes", async () => {
    mocks.dnsLookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const cases = [
      {
        clientId: "https://unsafe-redirect.example/client.json",
        body: { ...validCimd("https://unsafe-redirect.example/client.json"), redirect_uris: ["https://evil.example/callback"] },
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        status: 200,
      },
      {
        clientId: "https://redirect-response.example/client.json",
        body: validCimd("https://redirect-response.example/client.json"),
        headers: { "content-type": "application/json", location: "https://other.example/client.json" },
        status: 302,
      },
      {
        clientId: "https://html-response.example/client.json",
        body: validCimd("https://html-response.example/client.json"),
        headers: { "content-type": "text/html" },
        status: 200,
      },
      {
        clientId: "https://oversize-response.example/client.json",
        body: validCimd("https://oversize-response.example/client.json"),
        headers: { "content-type": "application/json", "content-length": "6000" },
        status: 200,
      },
    ];

    for (const entry of cases) {
      queueCimdResponse(entry.body, entry.headers, entry.clientId, entry.status);
      const res = await authorize(app, entry.clientId);
      expect(res.status, entry.clientId).toBeGreaterThanOrEqual(400);
      expect(extractConsentId(res.text), entry.clientId).toBeNull();
    }
    expect(mocks.httpsRequest).toHaveBeenCalledTimes(cases.length);
  });

  it("does not cache a valid document when its response says no-store", async () => {
    const clientId = "https://no-store.example/client.json";
    mocks.dnsLookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    for (let i = 0; i < 2; i++) {
      queueCimdResponse(validCimd(clientId), {
        "content-type": "application/json",
        "cache-control": "no-store",
      }, clientId);
      const res = await authorize(app, clientId);
      expect(res.status).toBe(200);
    }
    expect(mocks.dnsLookup).toHaveBeenCalledTimes(2);
    expect(mocks.httpsRequest).toHaveBeenCalledTimes(2);
  });
});
