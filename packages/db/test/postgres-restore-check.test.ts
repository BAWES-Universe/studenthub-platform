import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import pg from "pg";
import { runMigrations } from "@studenthub/db";

const DB_URL = process.env.DATABASE_URL ?? "";
const moduleUrl = process.env.SHU437_TEST_MODULE ?? new URL("../src/restore-check.js", import.meta.url).href;
const { checkRestore, formatRestoreCheckSummary } = await import(moduleUrl) as typeof import("../src/restore-check.js");
const execFileAsync = promisify(execFile);
const tag = `shu437_${process.pid}_${Date.now()}`;
const sourceName = `${tag}_source`;
const created: string[] = [];

function urlFor(database: string): string {
  const url = new URL(DB_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

let admin: pg.Pool;
async function createDatabase(name: string, template?: string): Promise<void> {
  await admin.query(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ""}`);
  created.push(name);
}
async function copy(suffix: string): Promise<{ name: string; url: string }> {
  const name = `${tag}_${suffix}_restore_check`;
  await createDatabase(name, sourceName);
  return { name, url: urlFor(name) };
}

before(async () => {
  if (!DB_URL) throw new Error("DATABASE_URL is required for SHU-437 PostgreSQL tests");
  const adminUrl = new URL(DB_URL); adminUrl.pathname = "/postgres";
  admin = new pg.Pool({ connectionString: adminUrl.toString() });
  await createDatabase(sourceName);
  const source = new pg.Pool({ connectionString: urlFor(sourceName) });
  try {
    await runMigrations(source);
    await source.query("INSERT INTO organizations (id, name) VALUES ('restore-parent', 'Restore Parent'), ('restore-child', 'Restore Child')");
    await source.query("INSERT INTO principals (id) VALUES ('restore-person')");
    await source.query("INSERT INTO grants (principal_id, org_id, role, scope) VALUES ('restore-person', 'restore-parent', 'staff', 'self')");
  } finally { await source.end(); }
});

after(async () => {
  for (const name of created.reverse()) {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [name]);
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  }
  await admin.end();
});

test("SHU104_COUNTS compares every table, migrations, and missing or unequal tables", async () => {
  const good = await copy("counts_good");
  const passing = await checkRestore(urlFor(sourceName), good.url);
  assert.equal(passing.ok, true);
  assert.ok(passing.tables.some((row) => row.table === "organizations" && row.matches));
  assert.equal(passing.migrations.matches, true);
  const sourcePool = new pg.Pool({ connectionString: urlFor(sourceName) });
  const catalogue = await sourcePool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name COLLATE \"C\"");
  await sourcePool.end();
  assert.deepEqual(passing.tables.map((row) => row.table), catalogue.rows.map((row) => row.table_name));

  const changed = await copy("counts_changed");
  const pool = new pg.Pool({ connectionString: changed.url });
  await pool.query("DELETE FROM grants WHERE principal_id = 'restore-person'");
  await pool.end();
  const report = await checkRestore(urlFor(sourceName), changed.url);
  assert.equal(report.ok, false);
  assert.equal(report.tables.find((row) => row.table === "grants")?.matches, false);
  const cli = new URL("../src/restore-check-cli.js", import.meta.url);
  await assert.rejects(execFileAsync(process.execPath, [cli.pathname, "--source", urlFor(sourceName), "--restored", changed.url]), (error: NodeJS.ErrnoException & { code?: number }) => error.code === 1);
  await assert.rejects(execFileAsync(process.execPath, [cli.pathname, "--source", urlFor(sourceName), "--restored", urlFor(`${tag}_unsafe`)]), (error: NodeJS.ErrnoException & { code?: number }) => error.code === 1);

  const migrationChanged = await copy("migration_changed");
  const migrationPool = new pg.Pool({ connectionString: migrationChanged.url });
  await migrationPool.query("DELETE FROM schema_migrations WHERE version = (SELECT max(version) FROM schema_migrations)");
  await migrationPool.end();
  assert.equal((await checkRestore(urlFor(sourceName), migrationChanged.url)).migrations.matches, false);

  const missing = await copy("missing_table");
  const missingPool = new pg.Pool({ connectionString: missing.url });
  await missingPool.query("DROP TABLE job_runs CASCADE");
  await missingPool.end();
  const missingReport = await checkRestore(urlFor(sourceName), missing.url);
  assert.equal(missingReport.tables.find((row) => row.table === "job_runs")?.restoredCount, -1);
  assert.equal(missingReport.ok, false);
});

test("SHU104_INTEGRITY reports foreign-key, sequence, and append-only trigger failures by name", async () => {
  const brokenFk = await copy("fk");
  let pool = new pg.Pool({ connectionString: brokenFk.url });
  const client = await pool.connect();
  await client.query("SET session_replication_role = replica");
  await client.query("DELETE FROM organizations WHERE id = 'restore-parent'");
  client.release();
  await pool.end();
  const fkReport = await checkRestore(urlFor(sourceName), brokenFk.url);
  assert.ok(fkReport.foreignKeys.some((row) => row.table === "grants" && !row.ok));

  const brokenSequence = await copy("sequence");
  pool = new pg.Pool({ connectionString: brokenSequence.url });
  await pool.query("SELECT setval(pg_get_serial_sequence('authorization_mutation_audit', 'id'), 1, false)");
  await pool.query(`INSERT INTO authorization_mutation_audit
    (id, request_ref, operation, target_principal_ref, before_summary, after_summary)
    VALUES (100, $1, 'principal.register', $2, $3, $3)`, ["a".repeat(64), "b".repeat(64), { existed: false, identityCount: 0, displayNamePresent: false, emailPresent: false }]);
  await pool.query("SELECT setval(pg_get_serial_sequence('authorization_mutation_audit', 'id'), 1, false)");
  await pool.end();
  const sequenceReport = await checkRestore(urlFor(sourceName), brokenSequence.url);
  assert.ok(sequenceReport.sequences.some((row) => row.table === "authorization_mutation_audit" && !row.ok));

  const brokenTrigger = await copy("trigger");
  pool = new pg.Pool({ connectionString: brokenTrigger.url });
  await pool.query("DROP TRIGGER authorization_mutation_audit_no_truncate ON authorization_mutation_audit");
  await pool.end();
  const triggerReport = await checkRestore(urlFor(sourceName), brokenTrigger.url);
  assert.ok(triggerReport.triggers.some((row) => row.constraint === "authorization_mutation_audit_no_truncate" && !row.ok));

  const missingObjects = await copy("missing_objects");
  pool = new pg.Pool({ connectionString: missingObjects.url });
  const fk = await pool.query<{ table_name: string; constraint_name: string }>(`SELECT rel.relname AS table_name, con.conname AS constraint_name
    FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND con.contype = 'f' ORDER BY rel.relname, con.conname LIMIT 1`);
  assert.ok(fk.rows[0]);
  const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
  await pool.query(`ALTER TABLE public.${quote(fk.rows[0]!.table_name)} DROP CONSTRAINT ${quote(fk.rows[0]!.constraint_name)}`);
  await pool.query("DROP SEQUENCE authorization_mutation_audit_id_seq CASCADE");
  await pool.end();
  const missingObjectsReport = await checkRestore(urlFor(sourceName), missingObjects.url);
  assert.ok(missingObjectsReport.foreignKeys.some((row) => row.constraint === fk.rows[0]!.constraint_name && !row.ok));
  assert.ok(missingObjectsReport.sequences.some((row) => row.constraint === "authorization_mutation_audit_id_seq" && !row.ok));
});

test("SHU104_SAFE_TARGET enforces scratch target and records recovery timing", async () => {
  await assert.rejects(checkRestore(urlFor(sourceName), urlFor(sourceName)), /must differ/);
  await assert.rejects(checkRestore(urlFor(sourceName), urlFor(`${tag}_unsafe`)), /scratch suffix/);
  const restored = await copy("timing");
  const report = await checkRestore(urlFor(sourceName), restored.url);
  assert.equal(report.sourceReadOnly, true, "the source session must behaviorally report read-only mode");
  assert.match(report.startedAt, /^\d{4}-/); assert.match(report.endedAt, /^\d{4}-/);
  assert.ok(report.elapsedSeconds >= 0);
});

test("SHU104_REPORT emits JSON-safe names, counts, constraints, and a short summary without row values or URLs", async () => {
  const restored = await copy("report");
  const report = await checkRestore(urlFor(sourceName), restored.url);
  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /restore-parent|Restore Parent|postgres:\/\//);
  assert.match(formatRestoreCheckSummary(report), /^restore check PASS: \d+ tables, \d+ foreign keys, \d+ sequences, \d+ triggers, 0 failures,/);
  const cli = new URL("../src/restore-check-cli.js", import.meta.url);
  const jsonOutput = await execFileAsync(process.execPath, [cli.pathname, "--source", urlFor(sourceName), "--restored", restored.url]);
  assert.equal(JSON.parse(jsonOutput.stdout).ok, true);
  assert.doesNotMatch(jsonOutput.stdout + jsonOutput.stderr, /postgres:\/\/|restore-parent|Restore Parent/);
  const textOutput = await execFileAsync(process.execPath, [cli.pathname, "--source", urlFor(sourceName), "--restored", restored.url, "--text"]);
  assert.match(textOutput.stdout, /^restore check PASS:/);
  assert.doesNotMatch(textOutput.stdout + textOutput.stderr, /postgres:\/\/|restore-parent|Restore Parent/);
});
