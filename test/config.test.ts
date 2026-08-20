import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// Canary: importing config.ts must not throw. This transitively exercises the
// config-at-import env solution wired up in vitest.config.ts.
import { buildConfig, config } from "../src/config.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("config loads at import (env is in place before module evaluation)", () => {
  it("builds config from the test env", () => {
    expect(config.whoop.clientId).toBe("test-client-id");
    expect(config.whoop.redirectUri).toBe("http://localhost:3000/auth/whoop/callback");
    expect(config.security.encryptionSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.security.accessPassword.length).toBeGreaterThanOrEqual(12);
    expect(config.security.mcpBearerToken).toBe("test-static-bearer-token-value-32-characters");
    expect(config.server.trustProxy).toBe(false);
    expect(config.server.bindHost).toBe("127.0.0.1");
  });

  it("loads the explicit generic athlete and event test fixture", () => {
    expect(config.event?.date).toBe("2030-12-31");
    expect(config.event?.phases).toHaveLength(1);
    expect(config.athlete).toMatchObject({
      sleep_target_hrs: 8,
      timezone: "UTC",
    });
    expect(config.thresholds.consecutive_red_alert).toBe(3);
  });
});

const productionEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  WHOOP_CLIENT_ID: "client",
  WHOOP_CLIENT_SECRET: "secret",
  WHOOP_REDIRECT_URI: "https://wellness.example/auth/whoop/callback",
  PUBLIC_URL: "https://wellness.example",
  ENCRYPTION_SECRET: "x".repeat(32),
  ACCESS_PASSWORD: "a-secure-password",
});

describe("runtime config validation and portable inputs", () => {
  it("never treats the example template as active runtime configuration", () => {
    const value = buildConfig(productionEnv(), process.cwd());
    expect(value.event).toBeNull();
    expect(value.athlete).toEqual({
      sleep_target_hrs: null,
      timezone: "UTC",
    });
    expect(value.security.allowedRedirectHosts).toEqual([]);
    expect(value.security.allowedOrigins).toEqual(["https://wellness.example"]);
  });

  it("loads JSON config and lets explicit env values override it", () => {
    const env = productionEnv();
    env.WHOOP_MCP_CONFIG_JSON = JSON.stringify({
      athlete: { sleep_target_hrs: 7.5, timezone: "UTC" },
      event: { name: "Generic event", date: "2027-01-02" },
    });
    env.SLEEP_TARGET_HOURS = "8.25";
    env.ATHLETE_TIMEZONE = "America/New_York";
    env.EVENT_DATE = "2027-02-03";
    env.TRUST_PROXY = "1";
    const value = buildConfig(env, process.cwd());
    expect(value.athlete).toMatchObject({
      sleep_target_hrs: 8.25,
      timezone: "America/New_York",
    });
    expect(value.event?.date).toBe("2027-02-03");
    expect(value.server.trustProxy).toBe(1);
  });

  it("does not mark timezone-only athlete settings as a configured sleep target", () => {
    const env = productionEnv();
    env.WHOOP_MCP_CONFIG_JSON = JSON.stringify({ athlete: { timezone: "Europe/London" } });
    const value = buildConfig(env, process.cwd());
    expect(value.athlete).toEqual({
      sleep_target_hrs: null,
      timezone: "Europe/London",
    });
  });

  it("binds locally by default and accepts an explicit container bind", () => {
    expect(buildConfig(productionEnv(), process.cwd()).server.bindHost).toBe("127.0.0.1");
    const env = productionEnv();
    env.BIND_HOST = "0.0.0.0";
    expect(buildConfig(env, process.cwd()).server.bindHost).toBe("0.0.0.0");
    env.BIND_HOST = "bad host/path";
    expect(() => buildConfig(env, process.cwd())).toThrow(/BIND_HOST/i);
  });

  it("rejects invalid event phases, time zones, callback origins, and trust proxy", () => {
    const phase = productionEnv();
    phase.WHOOP_MCP_CONFIG_JSON = JSON.stringify({
      event: {
        name: "Event",
        date: "2027-01-02",
        phases: [{ name: "late", start: "2027-01-01", end: "2027-01-03" }],
      },
    });
    expect(() => buildConfig(phase, process.cwd())).toThrow(/event\.date/i);

    const timezone = productionEnv();
    timezone.ATHLETE_TIMEZONE = "not/a-real-zone";
    expect(() => buildConfig(timezone, process.cwd())).toThrow(/IANA time zone/i);

    const origin = productionEnv();
    origin.WHOOP_REDIRECT_URI = "https://other.example/auth/whoop/callback";
    expect(() => buildConfig(origin, process.cwd())).toThrow(/share PUBLIC_URL's origin/i);

    const proxy = productionEnv();
    proxy.TRUST_PROXY = "all";
    expect(() => buildConfig(proxy, process.cwd())).toThrow(/TRUST_PROXY/i);

    proxy.TRUST_PROXY = "true";
    expect(() => buildConfig(proxy, process.cwd())).toThrow(/exact positive hop count/i);
  });

  it("requires HTTPS for every non-loopback deployment in every environment", () => {
    const env = productionEnv();
    env.NODE_ENV = "development";
    env.PUBLIC_URL = "http://wellness.example";
    env.WHOOP_REDIRECT_URI = "http://wellness.example/auth/whoop/callback";
    expect(() => buildConfig(env, process.cwd())).toThrow(/must use https unless.*loopback/i);
  });

  it("rejects an HTTP IPv6 issuer because the MCP auth router does not support it", () => {
    const ipv6 = productionEnv();
    ipv6.NODE_ENV = "development";
    ipv6.PUBLIC_URL = "http://[::1]:3000";
    ipv6.WHOOP_REDIRECT_URI = "http://[::1]:3000/auth/whoop/callback";
    expect(() => buildConfig(ipv6, process.cwd())).toThrow(/localhost or 127\.0\.0\.1/i);
  });

  it("accepts HTTP on the SDK-supported localhost and IPv4 loopback issuers", () => {
    const ipv4 = productionEnv();
    ipv4.NODE_ENV = "development";
    ipv4.PUBLIC_URL = "http://127.0.0.1:3000";
    ipv4.WHOOP_REDIRECT_URI = "http://127.0.0.1:3000/auth/whoop/callback";
    expect(buildConfig(ipv4, process.cwd()).server.publicUrl).toBe("http://127.0.0.1:3000");

    const localhost = productionEnv();
    localhost.NODE_ENV = "development";
    localhost.PUBLIC_URL = "http://localhost:3000";
    localhost.WHOOP_REDIRECT_URI = "http://localhost:3000/auth/whoop/callback";
    expect(buildConfig(localhost, process.cwd()).server.publicUrl).toBe("http://localhost:3000");
  });

  it("rejects weak configured static bearer tokens", () => {
    const env = productionEnv();
    env.MCP_BEARER_TOKEN = "short";
    expect(() => buildConfig(env, process.cwd())).toThrow(/at least 32/i);
  });

  it("supports mutually exclusive *_FILE inputs for deployment secrets", () => {
    const directory = mkdtempSync(join(tmpdir(), "whoop-config-secrets-"));
    temporaryDirectories.push(directory);
    const values = {
      WHOOP_CLIENT_SECRET: "client-secret-from-file",
      ENCRYPTION_SECRET: "e".repeat(32),
      ACCESS_PASSWORD: "password-from-file",
      MCP_BEARER_TOKEN: "m".repeat(32),
    };
    const env = productionEnv();
    for (const [name, value] of Object.entries(values)) {
      const file = join(directory, name.toLowerCase());
      writeFileSync(file, `${value}\n`, { mode: 0o600 });
      delete env[name];
      env[`${name}_FILE`] = file;
    }
    const value = buildConfig(env, directory);
    expect(value.whoop.clientSecret).toBe(values.WHOOP_CLIENT_SECRET);
    expect(value.security.mcpBearerToken).toBe(values.MCP_BEARER_TOKEN);

    env.WHOOP_CLIENT_SECRET = "also-direct";
    expect(() => buildConfig(env, directory)).toThrow(/only one of WHOOP_CLIENT_SECRET/i);
  });
});
