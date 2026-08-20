import Database from "better-sqlite3";
import { statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { useIsolatedDataDir } from "../helpers/db.js";

const dataDirectory = useIsolatedDataDir("storage");

import { getDb } from "../../src/db/connection.js";
import { initSchema } from "../../src/db/schema.js";

beforeAll(() => {
  initSchema(getDb());
});

describe("private local storage", () => {
  it.runIf(process.platform !== "win32")("restricts the data directory and database file", () => {
    expect(statSync(dataDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDirectory, "whoop-mcp.db")).mode & 0o777).toBe(0o600);
  });

  it("drops a legacy response cache while preserving encrypted token columns", () => {
    const legacy = new Database(":memory:");
    try {
      legacy.pragma("secure_delete = ON");
      legacy.exec(`
        CREATE TABLE tokens (
          id INTEGER PRIMARY KEY,
          access_token_encrypted TEXT NOT NULL,
          refresh_token_encrypted TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          scope TEXT NOT NULL,
          account_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO tokens VALUES (1, 'encrypted-access', 'encrypted-refresh', 1, 'offline', 'legacy-account', 1, 1);
        CREATE TABLE cache (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO cache VALUES ('recovery', 'legacy-wellness-json', 1, 1);
      `);

      initSchema(legacy);

      expect(legacy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cache'").get()).toBeUndefined();
      const columns = legacy.prepare("PRAGMA table_info(tokens)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain("account_id");
      expect(legacy.prepare("SELECT access_token_encrypted FROM tokens WHERE id = 1").get()).toEqual({
        access_token_encrypted: "encrypted-access",
      });
    } finally {
      legacy.close();
    }
  });
});
