import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresWorkImportStore } from "@studenthub/db/work";

// 0508 on a database that already holds imported rows (0505/0506 allowed a
// legacy_ref with no digest): it must apply, and those rows must stay as they
// are, reported on a re-run instead of overwritten. Synthetic rows only.
const url = process.env.DATABASE_URL;
// The same folder runMigrations reads: next to the built @studenthub/db.
const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.resolve("@studenthub/db")));
const ZERO = "0".repeat(64);
let admin: pg.Pool;
let pool: pg.Pool;
let schema: string;

before(async () => {
  assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database");
  admin = new pg.Pool({ connectionString: url });
  schema = `work_staff_upgrade_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
});
after(async () => {
  await pool?.end();
  if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin?.end();
});

test("STAFF_IMPORT_UPGRADE 0508 applies over imported rows written before it and keeps them as conflicts", async () => {
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
  const staff = `staff-upgrade-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id: staff, pbuuids: [], email: `${staff}@example.invalid` }));
  const question = randomUUID();
  await pool.query(`INSERT INTO work_staff_sessions(id, staff_principal_id, work_date, started_at, ended_at, source, legacy_ref)
    VALUES($1,$2,'2031-05-01','2031-05-01T05:00:00Z','2031-05-01T07:00:00Z','import','work_session_old'),
          ($3,$2,'2031-05-01','2031-05-01T08:00:00Z',NULL,'timer',NULL)`, [randomUUID(), staff, randomUUID()]);
  await pool.query("INSERT INTO work_standup_questions(id, question, legacy_ref) VALUES($1,'Plan?','question_old'), ($2,'Blockers?',NULL)", [question, randomUUID()]);
  await pool.query(`INSERT INTO work_standup_answers(id, staff_principal_id, question_id, question, answer, work_date, source, legacy_ref, created_at)
    VALUES($1,$2,$3,'Plan?','Call the stores','2031-05-01','import','answer_old','2031-05-01T05:30:00Z'),
          ($4,$2,$3,'Plan?','Visit','2031-05-02','app',NULL,'2031-05-02T05:30:00Z')`, [randomUUID(), staff, question, randomUUID()]);

  await pool.query("DELETE FROM schema_migrations WHERE version = '0508_work_staff_import'");
  await runMigrations(pool);

  // Imported rows carry the zero digest; rows made here have none.
  for (const table of ["work_staff_sessions", "work_standup_questions", "work_standup_answers"]) {
    const { rows } = await pool.query<{ ref: string | null; digest: string | null }>(`SELECT legacy_ref AS ref, legacy_digest AS digest FROM ${table} ORDER BY legacy_ref NULLS LAST`);
    assert.deepEqual(rows.map((r) => r.digest), [ZERO, null], table);
  }
  // Answers are frozen again after the backfill.
  await assert.rejects(pool.query("UPDATE work_standup_answers SET answer = 'x' WHERE legacy_ref = 'answer_old'"), { code: "23514" });

  // A re-run of the same legacy rows reports each one and changes nothing.
  const imports = new PostgresWorkImportStore(pool);
  const s = await imports.importStaffSessions([{ legacyRef: "work_session_old", staffPrincipalId: staff, workDate: "2031-05-01", startedAt: "2031-05-01T05:00:00.000Z", endedAt: "2031-05-01T07:00:00.000Z" }]);
  assert.deepEqual([s.inserted, s.updated, s.unchanged, s.conflicts.map((c) => [c.legacyRef, c.existingDigest])], [0, 0, 0, [["work_session_old", ZERO]]]);
  const q = await imports.importStandupQuestions([{ legacyRef: "question_old", question: "Plan?", createdAt: "2031-05-01T05:00:00.000Z", updatedAt: "2031-05-01T05:00:00.000Z" }]);
  assert.deepEqual(q.conflicts.map((c) => [c.legacyRef, c.existingDigest]), [["question_old", ZERO]]);
  const a = await imports.importStandupAnswers([{ legacyRef: "answer_old", staffPrincipalId: staff, questionLegacyRef: "question_old", question: "Plan?", answer: "Call the stores", workDate: "2031-05-01", createdAt: "2031-05-01T05:30:00.000Z" }]);
  assert.deepEqual(a.conflicts.map((c) => [c.legacyRef, c.existingDigest]), [["answer_old", ZERO]]);
  assert.equal((await pool.query("SELECT 1 FROM work_staff_sessions WHERE legacy_ref = 'work_session_old' AND ended_at = '2031-05-01T07:00:00Z'")).rowCount, 1);
});
