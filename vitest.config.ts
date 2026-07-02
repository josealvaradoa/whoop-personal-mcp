import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// --- Config-at-import solution -------------------------------------------------
// src/config.ts runs buildConfig() at module-evaluation time: it calls
// requireEnv() for WHOOP_CLIENT_ID/SECRET/REDIRECT_URI, ENCRYPTION_SECRET (>=32),
// ACCESS_PASSWORD (>=12), and reads a config file. ANY test that (transitively)
// imports config.ts therefore throws unless these are present BEFORE the module
// is evaluated. We provide them two ways for robustness:
//   1. process.env assignment here (covers the Vite/Vitest main process, e.g. any
//      config-resolution or globalSetup phase).
//   2. `test.env` below (injected into every test worker's process.env before the
//      test module — and thus config.ts — is imported).
// The example config file (whoop-mcp.config.example.json) satisfies loadConfigFile()
// since no whoop-mcp.config.json exists. DATA_DIR points at the OS tmp dir so tests
// never touch the repo's data/. DB-touching test files override DATA_DIR to a unique
// per-file directory at top-of-file (getDb() reads DATA_DIR lazily on first call).
const TEST_ENV: Record<string, string> = {
  WHOOP_CLIENT_ID: "test-client-id",
  WHOOP_CLIENT_SECRET: "test-client-secret",
  WHOOP_REDIRECT_URI: "http://localhost:3000/auth/whoop/callback",
  ENCRYPTION_SECRET: "test-encryption-secret-that-is-well-over-32-chars",
  ACCESS_PASSWORD: "test-access-password-1234",
  MCP_BEARER_TOKEN: "test-static-bearer-token-value",
  PUBLIC_URL: "http://localhost:3000",
  NODE_ENV: "test",
  DATA_DIR: join(tmpdir(), "whoop-mcp-test-default"),
};

for (const [k, v] of Object.entries(TEST_ENV)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

export default defineConfig({
  test: {
    environment: "node",
    env: TEST_ENV,
    include: ["test/**/*.test.ts"],
    // better-sqlite3 is a native addon; run each test file in an isolated forked
    // child process (default pool) so native modules load cleanly and the getDb()
    // singleton / module state is fresh per file.
    pool: "forks",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
