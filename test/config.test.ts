import { describe, it, expect } from "vitest";
// Canary: importing config.ts must not throw. This transitively exercises the
// config-at-import env solution wired up in vitest.config.ts. If the env were not
// in place before module evaluation, this import alone would throw at collection.
import { config } from "../src/config.js";

describe("config loads at import (env is in place before module evaluation)", () => {
  it("builds config from the test env + the example config file", () => {
    expect(config.whoop.clientId).toBe("test-client-id");
    expect(config.whoop.redirectUri).toBe("http://localhost:3000/auth/whoop/callback");
    expect(config.security.encryptionSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.security.accessPassword.length).toBeGreaterThanOrEqual(12);
    expect(config.security.mcpBearerToken).toBe("test-static-bearer-token-value");
  });

  it("loads race + thresholds from whoop-mcp.config.example.json", () => {
    expect(config.race.date).toBe("2026-10-18");
    expect(config.race.phases.length).toBeGreaterThan(0);
    expect(config.thresholds.acwr_danger).toBe(1.5);
    expect(config.thresholds.acwr_optimal_low).toBe(0.8);
    expect(config.thresholds.acwr_optimal_high).toBe(1.3);
    expect(config.athlete.sleep_target_hrs).toBe(8);
  });
});
