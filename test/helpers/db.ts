import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "../../src/db/connection.js";
import { initSchema } from "../../src/db/schema.js";
import { storeTokens } from "../../src/whoop/auth.js";

/**
 * Point DATA_DIR at a unique temp directory for this test file. getDb() reads
 * DATA_DIR lazily on its first call, so as long as this runs before any getDb()
 * usage (which it does — no module calls getDb() at import time), the SQLite file
 * is isolated per test file and never touches the repo's data/.
 */
export function useIsolatedDataDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `whoop-mcp-test-${label}-`));
  process.env.DATA_DIR = dir;
  return dir;
}

/** Create the SQLite connection and initialize all tables. */
export function initTestDb() {
  const db = getDb();
  initSchema(db);
  return db;
}

/**
 * Seed a valid WHOOP token (1h TTL). storeTokens also primes the in-memory token
 * cache in whoop/auth.ts, so getValidAccessToken() returns it with no network call
 * — the WHOOP API mock only ever sees data requests, never a token refresh.
 */
export function seedWhoopTokens(): void {
  storeTokens(
    "test-whoop-access-token",
    "test-whoop-refresh-token",
    3600,
    "read:recovery read:cycles read:sleep read:workout offline",
  );
}
