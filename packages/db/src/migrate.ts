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

/** Arbitrary fixed key; only runMigrations uses it (session-scoped, per-database). */
const MIGRATION_LOCK_KEY = 7_275_526;

/** Apply every pending migration on the given pool; safe to call repeatedly. */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const lockClient = await pool.connect();
  try {
    // Serialize concurrent runners (GPT R3 #2): two processes bootstrapping a
    // fresh database can both read the same pending set and race the ledger
    // insert (schema_migrations.version PK) — one would fail with a raw 23505
    // instead of a clean "already applied". pg_advisory_lock is global per
    // database and held by this session, so the second caller blocks here
    // until the first finishes, then re-reads the ledger and finds nothing
    // pending. The lock is released automatically if this session dies.
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

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
        // A failing ROLLBACK (e.g. connection dropped) must not mask the
        // original error (Sentry finding, valid).
        try {
          await client.query("ROLLBACK");
        } catch {
          // Swallow: the original error below is the one the caller needs.
        }
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await lockClient
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    lockClient.release();
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
