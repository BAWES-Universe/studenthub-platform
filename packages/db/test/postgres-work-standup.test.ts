import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresWorkStandupStore } from "@studenthub/db/work";
import { StandupService } from "../../work/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresWorkStandupStore;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  store = new PostgresWorkStandupStore(pool);
  if (!(await pool.query("SELECT 1 FROM organizations WHERE id = 'root'")).rowCount) await authz.upsertOrganization(createOrganization({ id: "root", name: "StudentHub" }));
});
after(async () => pool.end());

async function principal(prefix: string, grants: { orgId: string; role: string; scope: "self" | "subtree" }[] = []) {
  const id = `standup-${prefix}-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  if (grants.length) await authz.grantMany(id, grants as never);
  return id;
}
// One root admin per database: the first test makes it, the second reuses it.
let rootAdmin: string | undefined;
async function adminId() {
  rootAdmin ??= (await pool.query<{ principal_id: string }>("SELECT principal_id FROM grants WHERE org_id = 'root' AND role = 'admin' AND scope = 'subtree' LIMIT 1")).rows[0]?.principal_id
    ?? await principal("admin", [{ orgId: "root", role: "admin", scope: "subtree" }]);
  return rootAdmin;
}
const service = (now: { value: Date }) => new StandupService({ store, grants: authz, newId: () => randomUUID(), now: () => now.value });
const date = (now: Date) => new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
/** Starts the staff member's day (a session in progress), as the staff timer does. */
async function startDay(staffId: string, workDate: string, at: Date) {
  const id = randomUUID();
  await pool.query("INSERT INTO work_staff_sessions(id, staff_principal_id, work_date, started_at, source) VALUES($1,$2,$3::date,$4,'timer')", [id, staffId, workDate, at]);
  return id;
}

test("STANDUP_PG questions in order, one answer per question and Kuwait day, rewording keeps the answered text, retiring stops asking", async () => {
  // A far-off day of its own, so other tests' questions and answers don't meet this one's.
  const now = { value: new Date(Date.UTC(2031, 0, 1 + Math.floor(Math.random() * 3000), 21, 30)) };
  const day = date(now.value);
  const svc = service(now);
  const admin = await adminId();
  const staff = await principal("staff", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  const quiet = await principal("quiet", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  // Retire whatever other tests left asked, so this test sees only its own questions.
  for (const q of await store.questions()) await store.retireQuestion(q.id);
  const one = await svc.addQuestion(admin, "Blockers?");
  const two = await svc.addQuestion(admin, "Plans?");
  assert.ok(one.kind === "question" && two.kind === "question");
  const first = await svc.today(staff);
  assert.equal(first.kind === "today" && first.workDate, day);
  assert.equal(first.kind === "today" && first.next?.id, one.question.id);
  // Not before their day has started, and not ahead of the next question.
  assert.deepEqual(await svc.answer(staff, one.question.id, "None"), { kind: "refused", code: "not_working" });
  const session = await startDay(staff, day, now.value);
  assert.deepEqual(await svc.answer(staff, two.question.id, "A"), { kind: "refused", code: "out_of_order" });
  assert.deepEqual(await svc.answer(staff, one.question.id, "None"), { kind: "answered", workDate: day });
  // Two answers at once: one is saved.
  const both = await Promise.all([svc.answer(staff, two.question.id, "A"), svc.answer(staff, two.question.id, "B")]);
  assert.deepEqual(both.map((r) => r.kind).sort(), ["answered", "refused"]);
  assert.deepEqual(both.find((r) => r.kind === "refused"), { kind: "refused", code: "already_answered" });
  assert.equal(((await svc.today(staff)) as { next: unknown }).next, null);
  assert.equal((await svc.editQuestion(admin, one.question.id, "Anything blocking you?")).kind, "question");
  const answers = await svc.answers(admin, day, { staffId: staff });
  assert.deepEqual(answers.kind === "answers" && answers.answers.map((a) => a.question), ["Blockers?", "Plans?"]);
  assert.deepEqual(await svc.retireQuestion(admin, two.question.id), { kind: "retired" });
  await startDay(quiet, day, now.value);
  assert.deepEqual(await svc.answer(quiet, two.question.id, "x"), { kind: "refused", code: "not_found" });
  assert.deepEqual((await svc.questions(admin)), { kind: "questions", questions: [{ ...one.question, question: "Anything blocking you?" }] });
  const unanswered = await svc.unanswered(admin, day);
  assert.ok(unanswered.kind === "unanswered" && unanswered.staffIds.includes(quiet) && !unanswered.staffIds.includes(staff));
  // Once their day has ended, nothing more is taken.
  await pool.query("UPDATE work_staff_sessions SET ended_at = $2 WHERE id = $1", [session, new Date(now.value.getTime() + 60_000)]);
  assert.deepEqual(await svc.answer(quiet, one.question.id, "y"), { kind: "answered", workDate: day });
  await svc.addQuestion(admin, "Anything else?");
  const late = await svc.today(staff);
  assert.ok(late.kind === "today" && late.next);
  assert.deepEqual(await svc.answer(staff, late.next.id, "z"), { kind: "refused", code: "not_working" });
  await store.retireQuestion(late.next.id);
  // The next Kuwait day asks again.
  now.value = new Date(now.value.getTime() + 86_400_000);
  assert.equal(((await svc.today(staff)) as { next: { id: string } }).next.id, one.question.id);
});

test("STANDUP_PG answers page by staff then time; answers are never edited or removed and questions never deleted", async () => {
  const now = { value: new Date(Date.UTC(2041, 0, 1 + Math.floor(Math.random() * 3000), 6)) };
  const day = date(now.value);
  const admin = await adminId();
  const staff = await principal("staff", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  const q = await store.insertQuestion({ id: randomUUID(), question: "Paging?", createdBy: admin });
  for (let i = 0; i < 102; i++) {
    await pool.query("INSERT INTO work_standup_answers(id, staff_principal_id, question_id, question, answer, work_date, source, legacy_ref) VALUES($1,$2,$3,'Paging?',$4,$5::date,'import',$6)",
      [randomUUID(), staff, q.id, `a${i}`, day, `standup-test-${randomUUID()}`]);
  }
  const svc = service(now);
  const first = await svc.answers(admin, day, { staffId: staff });
  assert.ok(first.kind === "answers" && first.answers.length === 100 && first.next);
  const second = await svc.answers(admin, day, { staffId: staff, after: first.next });
  assert.ok(second.kind === "answers" && second.answers.length === 2 && second.next === null);
  assert.equal(new Set([...first.answers, ...second.answers].map((a) => a.id)).size, 102);
  await assert.rejects(pool.query("UPDATE work_standup_answers SET answer = 'changed' WHERE staff_principal_id = $1", [staff]), /never edited or removed/);
  await assert.rejects(pool.query("DELETE FROM work_standup_answers WHERE staff_principal_id = $1", [staff]), /never edited or removed/);
  await assert.rejects(pool.query("DELETE FROM work_standup_questions WHERE id = $1", [q.id]), /retired, never removed/);
  await assert.rejects(pool.query("INSERT INTO work_standup_answers(id, staff_principal_id, question_id, question, answer, work_date, source) VALUES($1,$2,$3,'Paging?','  ',$4::date,'app')", [randomUUID(), staff, q.id, day]), /check/i);
  await store.retireQuestion(q.id);
});

test("STANDUP_PG neither table can be emptied by TRUNCATE, directly or by a CASCADE from a parent", async () => {
  const refused = /stand-up questions and answers are never removed/;
  for (const statement of ["TRUNCATE work_standup_answers", "TRUNCATE work_standup_questions CASCADE", "TRUNCATE work_standup_answers, work_standup_questions",
    "TRUNCATE principals CASCADE"]) {
    const client = await pool.connect();
    try {
      // In a transaction that is rolled back, so a statement that wrongly ran wipes nothing.
      await client.query("BEGIN");
      // Other tables' TRUNCATE guards (pay, ID cards, ...) are lifted inside this transaction only,
      // so the refusal seen is the stand-up's whatever order the cascade reaches the tables in.
      const others = await client.query<{ table: string; trigger: string }>(
        `SELECT c.relname AS table, t.tgname AS trigger FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE NOT t.tgisinternal AND (t.tgtype & 32) <> 0 AND c.relname NOT LIKE 'work_standup_%'`);
      for (const o of others.rows) await client.query(`ALTER TABLE ${o.table} DISABLE TRIGGER ${o.trigger}`);
      await assert.rejects(client.query(statement), refused, statement);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
  assert.ok(((await pool.query("SELECT count(*)::int AS n FROM work_standup_answers")).rows[0] as { n: number }).n > 0);
});
