import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
});
after(async () => pool.end());

const TABLES = ["work_assignments", "work_events", "work_sessions", "work_decisions", "work_appeals", "work_appeal_updates", "work_staff_sessions"];

test("WORK_NO_TRUNCATE no work history table can be emptied by TRUNCATE, directly or by a CASCADE from a parent", async () => {
  const refused = /work history is append-only and never removed/;
  for (const statement of [...TABLES.map((t) => `TRUNCATE ${t} CASCADE`), `TRUNCATE ${TABLES.join(", ")}`, "TRUNCATE principals CASCADE", "TRUNCATE organizations CASCADE"]) {
    const client = await pool.connect();
    try {
      // In a transaction that is rolled back, so a statement that wrongly ran wipes nothing.
      await client.query("BEGIN");
      // Other tables' TRUNCATE guards are lifted inside this transaction only, so the refusal
      // seen is the work lane's whatever order the cascade reaches the tables in.
      const others = await client.query<{ table: string; trigger: string }>(
        `SELECT c.relname AS table, t.tgname AS trigger FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE NOT t.tgisinternal AND (t.tgtype & 32) <> 0 AND NOT (c.relname = ANY($1::text[]))`, [TABLES]);
      for (const o of others.rows) await client.query(`ALTER TABLE ${o.table} DISABLE TRIGGER ${o.trigger}`);
      await assert.rejects(client.query(statement), refused, statement);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
  // Each guard is a statement-level BEFORE TRUNCATE trigger that is switched on.
  const { rows } = await pool.query<{ table: string }>(
    "SELECT c.relname AS table FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = c.relname || '_no_truncate' AND t.tgenabled = 'O' AND (t.tgtype & 32) <> 0 AND (t.tgtype & 1) = 0 ORDER BY 1");
  for (const table of TABLES) assert.ok(rows.some((r) => r.table === table), table);
});
