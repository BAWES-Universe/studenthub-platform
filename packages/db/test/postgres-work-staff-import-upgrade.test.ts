import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresWorkImportStore, PostgresWorkStaffTimeStore } from "@studenthub/db/work";

// 0508 on a database that already holds imported rows (0505/0506 allowed a
// legacy_ref with no digest): it must apply, those rows keep working, and the
// importer holds them instead of comparing or overwriting. Synthetic rows only.
const url = process.env.DATABASE_URL;
// The same folder runMigrations reads: next to the built @studenthub/db.
const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.resolve("@studenthub/db")));
let admin: pg.Pool;
let pool: pg.Pool;
const schemas: { schema: string; pool: pg.Pool }[] = [];
/** A scratch schema of its own, dropped after the file. */
async function scratch(): Promise<pg.Pool> {
  const schema = `work_staff_upgrade_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const p = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
  schemas.push({ schema, pool: p });
  return p;
}
let schema: string;

before(async () => {
  assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database");
  admin = new pg.Pool({ connectionString: url });
  pool = await scratch();
  schema = schemas[0]!.schema;
});
after(async () => {
  for (const s of schemas) { await s.pool.end(); await admin.query(`DROP SCHEMA ${s.schema} CASCADE`); }
  await admin?.end();
});

test("STAFF_IMPORT_UPGRADE 0508 applies over rows imported before it; their digest stays unknown and the importer holds them", async () => {
  // Stop the schema at 0507: mark 0508 and everything after it as applied, migrate, then un-mark 0508 alone
  // (later migrations touch none of these tables).
  const later = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql") && f >= "0508").map((f) => f.replace(/\.sql$/, ""));
  assert.ok(later.includes("0508_work_staff_import"));
  await pool.query("CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  await pool.query("INSERT INTO schema_migrations(version) SELECT unnest($1::text[])", [later]);
  await runMigrations(pool);
  assert.equal((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'legacy_digest' AND table_name = 'work_staff_sessions'", [schema])).rowCount, 0);

  const authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: "root", name: "StudentHub" }));
  const person = async () => { const id = `staff-upgrade-${randomUUID()}`; await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` })); return id; };
  const staff = await person(), native = await person();
  const [importedOpen, nativeOpen, question] = [randomUUID(), randomUUID(), randomUUID()];
  // Pre-0508 state: an imported open session and a native (timer) control, an imported question with an
  // imported answer, and a native answer as control.
  await pool.query(`INSERT INTO work_staff_sessions(id, staff_principal_id, work_date, started_at, ended_at, source, legacy_ref)
    VALUES($1,$2,'2031-05-01','2031-05-01T05:00:00Z',NULL,'import','work_session_old'),
          ($3,$4,'2031-05-01','2031-05-01T05:00:00Z',NULL,'timer',NULL)`, [importedOpen, staff, nativeOpen, native]);
  await pool.query("INSERT INTO work_standup_questions(id, question, legacy_ref) VALUES($1,'Plan?','question_old')", [question]);
  await pool.query(`INSERT INTO work_standup_answers(id, staff_principal_id, question_id, question, answer, work_date, source, legacy_ref, created_at)
    VALUES($1,$2,$3,'Plan?','Call the stores','2031-05-01','import','answer_old','2031-05-01T05:30:00Z'),
          ($4,$5,$3,'Plan?','Visit','2031-05-01','app',NULL,'2031-05-01T05:30:00Z')`, [randomUUID(), staff, question, randomUUID(), native]);

  await pool.query("DELETE FROM schema_migrations WHERE version = '0508_work_staff_import'");
  await runMigrations(pool);

  // Nothing is made up: every digest is still NULL.
  for (const table of ["work_staff_sessions", "work_standup_questions", "work_standup_answers"]) {
    assert.deepEqual((await pool.query(`SELECT legacy_digest FROM ${table}`)).rows.map((r) => r.legacy_digest).filter((d) => d !== null), [], table);
  }
  // The normal timer still closes both open sessions, imported and native.
  const timer = new PostgresWorkStaffTimeStore(pool);
  assert.ok(await timer.end(importedOpen, new Date("2031-05-01T07:00:00Z")));
  assert.ok(await timer.end(nativeOpen, new Date("2031-05-01T07:30:00Z")));
  assert.equal((await pool.query("SELECT 1 FROM work_staff_sessions WHERE ended_at IS NULL")).rowCount, 0);
  // An unknown digest can't be filled in later, and answers stay frozen.
  await assert.rejects(pool.query(`UPDATE work_staff_sessions SET legacy_digest = repeat('a', 64) WHERE id = $1`, [importedOpen]), { code: "23514" });
  await assert.rejects(pool.query(`UPDATE work_standup_questions SET legacy_digest = repeat('a', 64) WHERE id = $1`, [question]), { code: "23514" });
  await assert.rejects(pool.query("UPDATE work_standup_answers SET answer = 'x' WHERE legacy_ref = 'answer_old'"), { code: "23514" });
  // A row imported from now on must carry its digest.
  await assert.rejects(pool.query(`INSERT INTO work_standup_questions(id, question, legacy_ref) VALUES($1,'Late?','question_new')`, [randomUUID()]), { code: "23514" });

  // A re-run holds each old row as unknown_digest: not compared, not overwritten, not counted unchanged.
  const imports = new PostgresWorkImportStore(pool);
  const held = (ref: string) => ({ inserted: 0, unchanged: 0, updated: 0, conflicts: [], refused: [{ legacyRef: ref, code: "unknown_digest" }] });
  assert.deepEqual(await imports.importStaffSessions([{ legacyRef: "work_session_old", staffPrincipalId: staff, workDate: "2031-05-01", startedAt: "2031-05-01T05:00:00.000Z", endedAt: "2031-05-01T09:00:00.000Z" }]), held("work_session_old"));
  assert.deepEqual(await imports.importStandupQuestions([{ legacyRef: "question_old", question: "Plan?", createdAt: "2031-05-01T05:00:00.000Z", updatedAt: "2031-05-01T05:00:00.000Z" }]), held("question_old"));
  assert.deepEqual(await imports.importStandupAnswers([{ legacyRef: "answer_old", staffPrincipalId: staff, questionLegacyRef: "question_old", question: "Plan?", answer: "Changed", workDate: "2031-05-01", createdAt: "2031-05-01T05:30:00.000Z" }]), held("answer_old"));
  assert.equal((await pool.query("SELECT 1 FROM work_staff_sessions WHERE id = $1 AND ended_at = '2031-05-01T07:00:00Z'", [importedOpen])).rowCount, 1);
  // New legacy rows still import (and replay) normally, an answer to the old question included.
  const fresh = { legacyRef: "answer_new", staffPrincipalId: staff, questionLegacyRef: "question_old", question: "Plan?", answer: "Visit", workDate: "2031-05-02", createdAt: "2031-05-02T05:30:00.000Z" };
  assert.equal((await imports.importStandupAnswers([fresh])).inserted, 1);
  assert.equal((await imports.importStandupAnswers([fresh])).unchanged, 1);
  const conflict = await imports.importStandupAnswers([{ ...fresh, answer: "Other" }]);
  assert.equal(conflict.conflicts.length, 1);

  // Reconciliation keeps ID coverage apart from content: the unknown row (held here, not passed by the run),
  // the real conflict (passed by the run) and an exact replay are all covered, but only the replay is verified.
  const replay = { ...fresh, legacyRef: "answer_replay" };
  assert.equal((await imports.importStandupAnswers([replay])).inserted, 1);
  assert.equal((await imports.importStandupAnswers([replay])).unchanged, 1);
  const recon = await imports.reconcileStaffImport("work_standup_answers", ["answer_old", "answer_new", "answer_replay", "answer_refused", "answer_gap"],
    ["answer_refused"], conflict.conflicts.map((c) => c.legacyRef));
  assert.deepEqual({ ...recon }, { table: "work_standup_answers", legacy: 5, imported: 3, missing: ["answer_gap"], skipped: ["answer_refused"], extra: [],
    covered: 3, held: ["answer_new", "answer_old"], verified: 1, clean: false });
});

test("STAFF_IMPORT_RECONCILE a table is clean only when every legacy ref is imported and content-accepted", async () => {
  const fresh = await scratch();
  await runMigrations(fresh);
  const imports = new PostgresWorkImportStore(fresh);
  const q = (legacyRef: string, question: string) => ({ legacyRef, question, createdAt: "2031-05-01T05:00:00.000Z", updatedAt: "2031-05-01T05:00:00.000Z" });
  assert.equal((await imports.importStandupQuestions([q("question_a", "Plan?"), q("question_b", "Blockers?")])).inserted, 2);
  const ok = await imports.reconcileStaffImport("work_standup_questions", ["question_a", "question_b"]);
  assert.deepEqual([ok.covered, ok.held, ok.verified, ok.clean], [2, [], 2, true]);
  // One content hold, one explained skip, one gap or one extra each spoil it.
  const again = await imports.importStandupQuestions([q("question_a", "Plan today?")]);
  assert.equal((await imports.reconcileStaffImport("work_standup_questions", ["question_a", "question_b"], [], again.conflicts.map((c) => c.legacyRef))).clean, false);
  assert.equal((await imports.reconcileStaffImport("work_standup_questions", ["question_a", "question_b", "question_c"], ["question_c"])).clean, false);
  assert.equal((await imports.reconcileStaffImport("work_standup_questions", ["question_a", "question_b", "question_c"])).clean, false);
  assert.equal((await imports.reconcileStaffImport("work_standup_questions", ["question_a"])).clean, false);
});
