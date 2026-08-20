import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let db: Database.Database | null = null;

function restrictPermissions(path: string, mode: number, label: string): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Some platforms/filesystems do not implement POSIX modes. Continue rather
    // than broadening permissions or making the service unavailable.
    console.warn(`[storage] Could not apply restrictive permissions to ${label}`);
  }
}

export function getDb(): Database.Database {
  if (db) return db;

  const dbDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
  mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  restrictPermissions(dbDir, 0o700, "data directory");

  const dbPath = join(dbDir, "whoop-mcp.db");
  db = new Database(dbPath);
  restrictPermissions(dbPath, 0o600, "database file");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  // Deleted legacy cache rows may have contained health data. Ask SQLite to
  // overwrite deleted cells rather than leaving recoverable freelist content.
  db.pragma("secure_delete = ON");
  db.pragma("journal_mode = WAL");
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) restrictPermissions(sidecar, 0o600, "database sidecar");
  }

  return db;
}

export function closeDb(): void {
  if (!db) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
    db = null;
  }
}
