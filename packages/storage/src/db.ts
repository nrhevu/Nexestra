import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { MIGRATIONS } from "./migrations.js";
import { databasePath, nexestraHome } from "./paths.js";
import * as schema from "./schema.js";

export type NexestraDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface OpenDatabaseOptions {
  /** Explicit database file. Defaults to `<NEXESTRA_HOME>/nexestra.db`. */
  path?: string;
  /** `":memory:"` shorthand for tests that do not need a file. */
  memory?: boolean;
}

export interface OpenedDatabase {
  db: NexestraDatabase;
  sqlite: Database.Database;
  file: string;
}

/**
 * Open (creating it if needed) the SQLite database and bring the schema up to
 * date. Migrations are applied in one transaction each and recorded in
 * `__nexestra_migrations`, so a restart is a no-op.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): OpenedDatabase {
  const file = options.memory ? ":memory:" : (options.path ?? databasePath(nexestraHome()));

  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });

  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  applyMigrations(sqlite);

  return { db: drizzle(sqlite, { schema }), sqlite, file };
}

/** Applied-migration bookkeeping, deliberately independent of drizzle-kit. */
export function applyMigrations(sqlite: Database.Database): string[] {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS __nexestra_migrations (tag TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)",
  );

  const applied = new Set(
    sqlite
      .prepare("SELECT tag FROM __nexestra_migrations")
      .all()
      .map((row) => (row as { tag: string }).tag),
  );

  const ran: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.tag)) continue;
    const run = sqlite.transaction(() => {
      for (const statement of migration.statements) sqlite.exec(statement);
      sqlite
        .prepare("INSERT INTO __nexestra_migrations (tag, appliedAt) VALUES (?, ?)")
        .run(migration.tag, new Date().toISOString());
    });
    run();
    ran.push(migration.tag);
  }
  return ran;
}

export { schema };
