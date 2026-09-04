#!/usr/bin/env node
/**
 * Repeatable schema migration runner for the authz tables (SHU-55).
 *
 * Ledger model: a schema_migrations(version, applied_at) table records every
 * applied migration. On each run we apply the .sql files under
 * ../migrations (relative to this compiled file) that are NOT yet recorded,
 * in filename order, each inside its own transaction so a failed migration
 * leaves no half-applied schema. Re-running is a no-op.
 *
 * The schema_migrations ledger makes reruns safe even though the .sql files
 * are also written IF NOT EXISTS-idempotent: the ledger is the source of
 * truth, the IF NOT EXISTS guards only protect hand-created databases.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { databaseUrl } from "./connection.js";

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

/** Apply every pending migration on the given pool; safe to call repeatedly. */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations",
  );
  const applied = new Set(rows.map((row) => row.version));

  // Zero-padded numeric prefixes make plain lexicographic order = apply order.
  const pending = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => !applied.has(file.replace(/\.sql$/, "")));

  for (const file of pending) {
    const version = file.replace(/\.sql$/, "");
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [version],
      );
      await client.query("COMMIT");
      console.log(`db: applied migration ${file}`);
    } catch (error) {
      // The migration file runs as one multi-statement query inside the
      // transaction; any failure aborts the whole file, nothing is recorded.
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    await runMigrations(pool);
    console.log("db: migrations up to date");
  } finally {
    await pool.end();
  }
}

// Run only when executed directly (`node dist/migrate.js`), not when this
// module is imported by bootstrap-admin or the test suite.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error("db: migration failed:", error);
    process.exitCode = 1;
  });
}
