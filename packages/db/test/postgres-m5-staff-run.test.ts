// M-5 staff time against PostgreSQL: the staff resolution query the importer runs, and the run
// through the work lane's real import store. Synthetic principals and rows only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresWorkImportStore } from "@studenthub/db/work";
import { postgresTarget } from "../../../tools/legacy-import/src/m4-cli.js";
import { planStaffWork, resolveStaff, runStaffWork, staffCandidates, type M5StaffSources } from "../../../tools/legacy-import/src/m5-staff.js";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  const authz = new PostgresAuthzStore(pool);
  if (!(await pool.query("SELECT 1 FROM organizations WHERE id = 'root'")).rowCount) await authz.upsertOrganization(createOrganization({ id: "root", name: "StudentHub" }));
});
after(async () => pool.end());

const run = randomUUID().slice(0, 8);
/** A principal with an address; verified by the issuer or by a legacy import; with or without an operator grant. */
async function person(name: string, opts: { verified?: "oidc" | "legacy_import" | false; role?: string | null; org?: string } = {}) {
  const id = `m5-${name}-${randomUUID()}`, email = `${name}-${run}@Example.invalid`;
  await pool.query("INSERT INTO principals (id, email) VALUES ($1, $2)", [id, email]);
  const verified = opts.verified ?? "oidc";
  if (verified) await pool.query("INSERT INTO principal_email_verifications (principal_id, email, verified, source) VALUES ($1, principal_email_key($2), true, $3)", [id, email, verified]);
  const role = opts.role === undefined ? "staff" : opts.role;
  if (role) await pool.query("INSERT INTO grants (principal_id, org_id, role, scope) VALUES ($1, $2, $3, 'subtree')", [id, opts.org ?? "root", role]);
  return { id, email };
}

test("STAFF_M5_PG the importer's staff match: the address key on both sides, issuer-verified, operator staff or admin only", async () => {
  const target = postgresTarget(URL, "a".repeat(64), "root", null);
  try {
    const ok = await person("ok");
    const admin = await person("admin", { role: "admin" });
    const imported = await person("imported", { verified: "legacy_import" });
    const unverified = await person("unverified", { verified: false });
    const candidate = await person("candidate", { role: "candidate" });
    const elsewhere = await person("elsewhere", { org: (await pool.query("INSERT INTO organizations (id, name) VALUES ($1, 'Other') RETURNING id", [`m5-org-${randomUUID()}`])).rows[0].id });
    // Legacy addresses as legacy held them: other case and outer spaces fold to the same key.
    const rows = [ok, admin, imported, unverified, candidate, elsewhere].map((p, i) => ({ staff_id: i + 1, staff_email: `  ${p.email.toUpperCase()} `, deleted: 0, hours_per_day: 8 }));
    rows.push({ staff_id: 7, staff_email: `nobody-${run}@example.invalid`, deleted: 0, hours_per_day: 8 });
    const r = await resolveStaff(staffCandidates(rows).candidates, target.staffMatcher(), "root");
    assert.deepEqual(Object.fromEntries(r.principals), { 1: ok.id, 2: admin.id });
    assert.deepEqual(Object.fromEntries(r.unresolved), { 3: "unresolved", 4: "unresolved", 5: "notOperatorStaff", 6: "notOperatorStaff", 7: "unresolved" });
  } finally { await target.close(); }
});

test("STAFF_M5_PG_RUN the run writes through the real store: questions before answers, a re-run unchanged, an unresolved member skipped", async () => {
  const target = postgresTarget(URL, "a".repeat(64), "root", null);
  const store = new PostgresWorkImportStore(pool);
  try {
    const staff = await person("runner");
    const ref = (p: string) => `${p}-${randomUUID()}`;
    const s1 = ref("s"), s2 = ref("s"), q1 = ref("q"), a1 = ref("a"), a2 = ref("a");
    // Legacy staff ids unique to this run: `staff:<id>` is a table-wide key.
    const id1 = Date.now() * 10, id2 = id1 + 1;
    const sources = {
      staff: [{ staff_id: id1, staff_email: staff.email, deleted: 0, hours_per_day: 6 }, { staff_id: id2, staff_email: `ghost-${run}@example.invalid`, deleted: 0, hours_per_day: 8 }],
      staff_work_session: [
        { work_session_uuid: s1, staff_id: id1, total_minutes: 60, created_at: "2026-11-01 09:00:00", updated_at: "2026-11-01 10:00:00" },
        { work_session_uuid: s2, staff_id: id2, total_minutes: 60, created_at: "2026-11-01 09:00:00", updated_at: "2026-11-01 10:00:00" },
      ],
      daily_standup_question: [{ question_uuid: q1, question: "What did you finish?", created_at: "2026-10-01 09:00:00", updated_at: "2026-10-01 09:00:00" }],
      daily_standup_answer: [
        { answer_uuid: a1, staff_id: id1, question_uuid: q1, question: "What did you finish?", answer: "Synthetic", created_at: "2026-11-01 09:30:00" },
        { answer_uuid: a2, staff_id: id1, question_uuid: `gone-${randomUUID()}`, question: "Deleted question?", answer: "Synthetic", created_at: "2026-11-01 09:40:00" },
      ],
    } as unknown as M5StaffSources;
    const resolution = await resolveStaff(staffCandidates(sources.staff).candidates, target.staffMatcher(), "root");
    const plan = planStaffWork(sources, resolution);
    const first = await runStaffWork(store, plan);
    assert.deepEqual([first.tables.work_standup_questions.inserted, first.tables.work_staff_sessions.inserted, first.tables.work_standup_answers.inserted, first.tables.work_staff_hours_per_day.inserted], [1, 1, 1, 1]);
    assert.deepEqual(first.refs.work_staff_sessions.skipped, [s2], "the unresolved member's session is skipped and explained");
    assert.deepEqual(first.refs.work_standup_answers.refused, { no_question: [a2] }, "an answer to a question legacy deleted is refused by the store");
    assert.ok(![s1, s2].some((r) => first.refs.work_staff_sessions.missing.includes(r)));
    const row = (await pool.query("SELECT staff_principal_id, work_date::text, source FROM work_staff_sessions WHERE legacy_ref = $1", [s1])).rows[0];
    assert.deepEqual(row, { staff_principal_id: staff.id, work_date: "2026-11-01", source: "import" });
    assert.equal((await pool.query("SELECT hours FROM work_staff_hours_per_day WHERE staff_principal_id = $1", [staff.id])).rows[0]?.hours, 6);
    const again = await runStaffWork(store, plan);
    assert.deepEqual([again.tables.work_standup_questions.unchanged, again.tables.work_staff_sessions.unchanged, again.tables.work_standup_answers.unchanged, again.tables.work_staff_hours_per_day.unchanged], [1, 1, 1, 1]);
    assert.deepEqual([again.tables.work_staff_sessions.inserted, again.tables.work_staff_sessions.conflicts], [0, 0]);
  } finally { await target.close(); }
});
