import type Database from "better-sqlite3";

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      scope TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Remove the short-lived account namespace used by an earlier cache design,
  // preserving encrypted credentials while returning to the minimal one-row
  // token schema.
  const tokenColumns = db.prepare("PRAGMA table_info(tokens)").all() as Array<{ name: string }>;
  if (tokenColumns.some((column) => column.name === "account_id")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE tokens_without_account_id (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          access_token_encrypted TEXT NOT NULL,
          refresh_token_encrypted TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          scope TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      db.exec(`
        INSERT INTO tokens_without_account_id
          (id, access_token_encrypted, refresh_token_encrypted, expires_at, scope, created_at, updated_at)
        SELECT id, access_token_encrypted, refresh_token_encrypted, expires_at, scope, created_at, updated_at
        FROM tokens
      `);
      db.exec("DROP TABLE tokens");
      db.exec("ALTER TABLE tokens_without_account_id RENAME TO tokens");
    })();
  }

  // Persistent response caching is deliberately unsupported. Purge any legacy
  // cache table (plaintext or encrypted) rather than carrying wellness data
  // forward. secure_delete is enabled by the connection before this runs.
  const cacheTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cache'").get();
  if (cacheTable) {
    db.exec("DROP TABLE cache");
    db.pragma("wal_checkpoint(TRUNCATE)");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_clients (
      client_id TEXT PRIMARY KEY,
      client_info TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_access_tokens (
      token TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_refresh_tokens (
      token TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
}
