import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrations } from "./migrations";

export type DB = Database.Database;

/** Where the library keeps its database. Override with COMPONENT_LIBRARY_HOME. */
export function dataDir(): string {
  const fromEnv = process.env.COMPONENT_LIBRARY_HOME;
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".component-library");
}

export function defaultDbPath(): string {
  return path.join(dataDir(), "library.db");
}

export function openDatabase(file: string = defaultDbPath()): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

/** Applies any migrations not yet recorded. Safe to call on every start. */
export function migrate(db: DB): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r: any) => r.version as number),
  );
  const ran: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    })();
    ran.push(m.version);
  }
  return ran;
}

/** The shared folder where packaged component code is copied. Override with COMPONENT_LIBRARY_CODE_DIR. */
export function libraryCodeDir(): string {
  const fromEnv = process.env.COMPONENT_LIBRARY_CODE_DIR;
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), "component-library", "library");
}
