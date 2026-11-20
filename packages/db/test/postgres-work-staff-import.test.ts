import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresWorkImportStore, PostgresWorkStaffTimeStore, PostgresWorkStandupStore } from "@studenthub/db/work";
import { mapLegacyStaffSession, mapLegacyStandupAnswer, mapLegacyStandupQuestion } from "../../work/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, imports: PostgresWorkImportStore;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  imports = new PostgresWorkImportStore(pool);
  if (!(await pool.query("SELECT 1 FROM organizations WHERE id = 'root'")).rowCount) await authz.upsertOrganization(createOrganization({ id: "root", name: "StudentHub" }));
});
after(async () => pool.end());

async function principal(prefix: string) {
  const id = `staff-import-${prefix}-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  return id;
}
const empty = { inserted: 0, unchanged: 0, updated: 0, conflicts: [], refused: [] };

test("STAFF_IMPORT_PG staff sessions: keyed by legacy ref, an open session ends once, other changes are conflicts", async () => {
  const staff = await principal("s");
  const tag = randomUUID().slice(0, 8);
  const toRow = (id: string, created: string, minutes: number | null, updated: string) => {
    const s = mapLegacyStaffSession({ work_session_uuid: `work_session_${tag}-${id}`, staff_id: 12, total_minutes: minutes, created_at: created, updated_at: updated }).session!;
    return { legacyRef: s.legacyRef, staffPrincipalId: staff, workDate: s.workDate, startedAt: s.startedAt.toISOString(), endedAt: s.endedAt?.toISOString() ?? null };
  };
  const closed = toRow("1", "2031-03-02 09:00:00", 125, "2031-03-02 11:05:30");
  const open = toRow("2", "2031-03-03 09:00:00", null, "2031-03-03 09:00:00");
  const second = toRow("3", "2031-03-03 13:00:00", null, "2031-03-03 13:00:00");
  const result = await imports.importStaffSessions([closed, open, second]);
  assert.deepEqual(result, { ...empty, inserted: 2, refused: [{ legacyRef: second.legacyRef, code: "open_twice" }] });
  const held = await pool.query(`SELECT legacy_ref, to_char(work_date,'YYYY-MM-DD') AS d, minutes, source, ended_at IS NULL AS open FROM work_staff_sessions
    WHERE staff_principal_id = $1 ORDER BY started_at`, [staff]);
  assert.deepEqual(held.rows, [{ legacy_ref: closed.legacyRef, d: "2031-03-02", minutes: 125, source: "import", open: false },
    { legacy_ref: open.legacyRef, d: "2031-03-03", minutes: null, source: "import", open: true }]);
  assert.deepEqual(await imports.importStaffSessions([closed, open]), { ...empty, unchanged: 2 });
  // Legacy has since ended the open session: the end is written once.
  const ended = { ...open, endedAt: "2031-03-03T08:00:00.000Z" };
  assert.deepEqual(await imports.importStaffSessions([ended]), { ...empty, updated: 1 });
  assert.deepEqual(await imports.importStaffSessions([ended]), { ...empty, unchanged: 1 });
  // Reopening, moving the end or moving the start is a conflict and nothing changes.
  for (const changed of [open, { ...ended, endedAt: "2031-03-03T09:00:00.000Z" }, { ...closed, startedAt: "2031-03-02T05:00:00.000Z" }]) {
    const r = await imports.importStaffSessions([changed]);
    assert.equal(r.conflicts.length, 1, JSON.stringify(changed));
    assert.match(r.conflicts[0]!.existingDigest, /^[0-9a-f]{64}$/);
    assert.notEqual(r.conflicts[0]!.existingDigest, r.conflicts[0]!.incomingDigest);
  }
  assert.equal((await pool.query("SELECT minutes FROM work_staff_sessions WHERE legacy_ref = $1", [open.legacyRef])).rows[0].minutes, 120);
  // The import key is fixed once written.
  await assert.rejects(pool.query("UPDATE work_staff_sessions SET legacy_digest = repeat('0', 64) WHERE legacy_ref = $1", [closed.legacyRef]), /only the end is written/);
  // Two batches racing on one new ref: one inserts, the other finds it unchanged.
  const raced = toRow("4", "2031-03-04 09:00:00", 60, "2031-03-04 10:00:00");
  const both = await Promise.all([imports.importStaffSessions([raced]), imports.importStaffSessions([raced])]);
  assert.deepEqual(both.map((r) => [r.inserted, r.unchanged]).sort(), [[0, 1], [1, 0]]);

  // Legacy closed an imported open session and opened another the same day: either input order imports both.
  for (const [i, order] of [["a", "closedFirst"], ["b", "openFirst"]] as const) {
    const first = toRow(`${i}1`, `2031-03-1${i === "a" ? 5 : 6} 08:00:00`, null, "2031-03-15 08:00:00");
    assert.equal((await imports.importStaffSessions([first])).inserted, 1);
    const closing = { ...first, endedAt: new Date(Date.parse(first.startedAt) + 3600_000).toISOString() };
    const next = toRow(`${i}2`, `2031-03-1${i === "a" ? 5 : 6} 10:00:00`, null, "2031-03-15 10:00:00");
    const r = await imports.importStaffSessions(order === "closedFirst" ? [closing, next] : [next, closing]);
    assert.deepEqual([r.updated, r.inserted, r.refused], [1, 1, []], order);
  }
  // Two batches opening sessions for one staff member on the same two days in opposite orders:
  // neither deadlocks; each day keeps one open session and the other is refused as open_twice.
  const racer = await principal("race");
  const openOn = (id: string, day: string) => ({ legacyRef: `work_session_${tag}-${id}`, staffPrincipalId: racer, workDate: day, startedAt: `${day}T05:00:00.000Z`, endedAt: null });
  const [left, right] = await Promise.all([
    imports.importStaffSessions([openOn("L1", "2031-03-20"), openOn("L2", "2031-03-21")]),
    imports.importStaffSessions([openOn("R2", "2031-03-21"), openOn("R1", "2031-03-20")]),
  ]);
  assert.equal(left.inserted + right.inserted, 2);
  assert.deepEqual([...left.refused, ...right.refused].map((x) => x.code), ["open_twice", "open_twice"]);
  const gap = `work_session_${tag}-gap`;
  const recon = await imports.reconcileStaffImport("work_staff_sessions", [closed.legacyRef, open.legacyRef, second.legacyRef, raced.legacyRef, gap], [second.legacyRef]);
  assert.equal(recon.legacy, 5);
  // The refused second open session is explained; the row nobody reported is a gap.
  assert.deepEqual([recon.skipped, recon.missing], [[second.legacyRef], [gap]]);
  // A reported row that was imported anyway is neither.
  assert.deepEqual((await imports.reconcileStaffImport("work_staff_sessions", [closed.legacyRef], [closed.legacyRef])).skipped, []);
  assert.ok(recon.imported >= 3);
  assert.ok(![closed.legacyRef, open.legacyRef, raced.legacyRef].some((r) => recon.extra.includes(r)));
  await assert.rejects(imports.reconcileStaffImport("principals" as never, []), /unknown staff import table/);
});

test("STAFF_IMPORT_PG stand-up questions then answers: repeats on a day kept, missing questions refused, reconciled by ref", async () => {
  const staff = await principal("a");
  const tag = randomUUID().slice(0, 8);
  const q = mapLegacyStandupQuestion({ question_uuid: `question_${tag}`, question: "What did you finish?", created_at: "2031-04-01 08:00:00", updated_at: "2031-04-02 08:00:00" }).question!;
  const question = { legacyRef: q.legacyRef, question: q.question, createdAt: q.createdAt.toISOString(), updatedAt: q.updatedAt.toISOString() };
  try {
    assert.deepEqual(await imports.importStandupQuestions([question]), { ...empty, inserted: 1 });
    assert.deepEqual(await imports.importStandupQuestions([question]), { ...empty, unchanged: 1 });
    assert.equal((await imports.importStandupQuestions([{ ...question, question: "Reworded?" }])).conflicts.length, 1);
    const stored = (await pool.query("SELECT question, retired_at, created_by FROM work_standup_questions WHERE legacy_ref = $1", [q.legacyRef])).rows[0];
    assert.deepEqual(stored, { question: "What did you finish?", retired_at: null, created_by: null });
    await assert.rejects(pool.query("UPDATE work_standup_questions SET legacy_ref = 'other' WHERE legacy_ref = $1", [q.legacyRef]), /import key is never changed/);

    const toAnswer = (id: string, created: string, questionRef = q.legacyRef, text = "Shipped the report") => {
      const a = mapLegacyStandupAnswer({ answer_uuid: `answer_${tag}-${id}`, staff_id: 12, question_uuid: questionRef, question: "What did you finish? (as asked)", answer: text, created_at: created }).answer!;
      return { legacyRef: a.legacyRef, staffPrincipalId: staff, questionLegacyRef: a.questionLegacyRef, question: a.question, answer: a.answer, workDate: a.workDate, createdAt: a.createdAt.toISOString() };
    };
    const first = toAnswer("1", "2031-04-03 09:00:00");
    // Legacy allowed a second answer to the same question on one day: it is kept.
    const again = toAnswer("2", "2031-04-03 23:59:00", q.legacyRef, "And the export");
    const orphan = toAnswer("3", "2031-04-03 10:00:00", "question_deleted");
    // Text Postgres can't store is refused for its row only, if one ever gets past the mapper.
    const nul = { ...toAnswer("4", "2031-04-03 11:00:00"), answer: "Done\u0000today" };
    assert.deepEqual(await imports.importStandupAnswers([toAnswer("5", "2031-04-04 09:00:00"), nul]), { ...empty, inserted: 1, refused: [{ legacyRef: nul.legacyRef, code: "invalid" }] });
    assert.deepEqual(await imports.importStandupAnswers([first, again, orphan]), { ...empty, inserted: 2, refused: [{ legacyRef: orphan.legacyRef, code: "no_question" }] });
    assert.deepEqual(await imports.importStandupAnswers([first, again]), { ...empty, unchanged: 2 });
    assert.equal((await imports.importStandupAnswers([{ ...first, answer: "Changed" }])).conflicts.length, 1);
    const rows = (await pool.query(`SELECT a.legacy_ref, a.question, to_char(a.work_date,'YYYY-MM-DD') AS d, a.source, a.created_at, q.legacy_ref AS q FROM work_standup_answers a
      JOIN work_standup_questions q ON q.id = a.question_id WHERE a.staff_principal_id = $1 ORDER BY a.created_at`, [staff])).rows;
    assert.deepEqual(rows.map((r) => [r.legacy_ref, r.question, r.d, r.source, r.created_at.toISOString(), r.q]), [
      [first.legacyRef, "What did you finish? (as asked)", "2031-04-03", "import", "2031-04-03T06:00:00.000Z", q.legacyRef],
      [again.legacyRef, "What did you finish? (as asked)", "2031-04-03", "import", "2031-04-03T20:59:00.000Z", q.legacyRef],
      [`answer_${tag}-5`, "What did you finish? (as asked)", "2031-04-04", "import", "2031-04-04T06:00:00.000Z", q.legacyRef],
    ]);
    const recon = await imports.reconcileStaffImport("work_standup_answers", [first.legacyRef, again.legacyRef, orphan.legacyRef]);
    assert.deepEqual([recon.table, recon.legacy, recon.missing, recon.skipped], ["work_standup_answers", 3, [orphan.legacyRef], []]);
    const qRecon = await imports.reconcileStaffImport("work_standup_questions", []);
    assert.ok(qRecon.extra.includes(q.legacyRef));
    assert.equal(qRecon.legacy, 0);
  } finally {
    // Imported questions are asked like any other: stop asking this one, so other suites see only their own.
    await pool.query("UPDATE work_standup_questions SET retired_at = clock_timestamp() WHERE legacy_ref = $1 AND retired_at IS NULL", [q.legacyRef]);
  }
});

test("STAFF_IMPORT_PG an imported question edited or retired here is a conflict on replay, never unchanged or verified", async () => {
  const standup = new PostgresWorkStandupStore(pool);
  const tag = randomUUID().slice(0, 8);
  const row = (n: string) => ({ legacyRef: `question_${tag}-${n}`, question: `Question ${n}?`, createdAt: "2031-04-01T05:00:00.000Z", updatedAt: "2031-04-01T05:00:00.000Z" });
  const [kept, edited, retired] = [row("kept"), row("edited"), row("retired")];
  try {
    assert.deepEqual(await imports.importStandupQuestions([kept, edited, retired]), { ...empty, inserted: 3 });
    const id = async (ref: string) => (await pool.query("SELECT id FROM work_standup_questions WHERE legacy_ref = $1", [ref])).rows[0].id as string;
    assert.ok(await standup.editQuestion(await id(edited.legacyRef), "Question edited here?"));
    assert.ok(await standup.retireQuestion(await id(retired.legacyRef)));
    // The same legacy rows again: only the untouched one is unchanged; the stored rows are left as they are.
    const replay = await imports.importStandupQuestions([kept, edited, retired]);
    assert.deepEqual([replay.unchanged, replay.updated, replay.inserted, replay.conflicts.map((c) => c.legacyRef).sort()], [1, 0, 0, [edited.legacyRef, retired.legacyRef].sort()]);
    for (const c of replay.conflicts) assert.notEqual(c.existingDigest, c.incomingDigest);
    assert.equal((await pool.query("SELECT question FROM work_standup_questions WHERE legacy_ref = $1", [edited.legacyRef])).rows[0].question, "Question edited here?");
    // Text changed with the update stamp left alone (outside the store) is caught by the text itself.
    const quiet = row("quiet");
    assert.equal((await imports.importStandupQuestions([quiet])).inserted, 1);
    await pool.query("UPDATE work_standup_questions SET question = 'Changed quietly?' WHERE legacy_ref = $1", [quiet.legacyRef]);
    assert.equal((await imports.importStandupQuestions([quiet])).conflicts.length, 1);
    const recon = await imports.reconcileStaffImport("work_standup_questions", [kept.legacyRef, edited.legacyRef, retired.legacyRef], [], replay.conflicts.map((c) => c.legacyRef));
    assert.deepEqual([recon.covered, recon.held, recon.verified, recon.clean], [3, [edited.legacyRef, retired.legacyRef].sort(), 1, false]);
  } finally {
    await pool.query("UPDATE work_standup_questions SET retired_at = clock_timestamp() WHERE legacy_ref LIKE $1 AND retired_at IS NULL", [`question_${tag}-%`]);
  }
});

test("STAFF_IMPORT_PG a session the timer ended here is never reopened or moved by a stale legacy replay", async () => {
  const staff = await principal("h");
  const timer = new PostgresWorkStaffTimeStore(pool);
  const open = { legacyRef: `work_session_${randomUUID().slice(0, 8)}`, staffPrincipalId: staff, workDate: "2031-06-01", startedAt: "2031-06-01T05:00:00.000Z", endedAt: null };
  assert.deepEqual(await imports.importStaffSessions([open]), { ...empty, inserted: 1 });
  const id = (await pool.query("SELECT id FROM work_staff_sessions WHERE legacy_ref = $1", [open.legacyRef])).rows[0].id as string;
  // Platform owns the close from here: the timer ends the imported open session.
  assert.ok(await timer.end(id, new Date("2031-06-01T07:00:00.000Z")));
  // Legacy still showing it open, or ending it at another time, is a conflict; the timer's end stays.
  for (const stale of [open, { ...open, endedAt: "2031-06-01T09:00:00.000Z" }]) {
    const r = await imports.importStaffSessions([stale]);
    assert.deepEqual([r.unchanged, r.updated, r.conflicts.length], [0, 0, 1]);
  }
  // Legacy agreeing with the timer's end is unchanged.
  assert.deepEqual(await imports.importStaffSessions([{ ...open, endedAt: "2031-06-01T07:00:00.000Z" }]), { ...empty, unchanged: 1 });
  assert.equal((await pool.query("SELECT ended_at FROM work_staff_sessions WHERE id = $1", [id])).rows[0].ended_at.toISOString(), "2031-06-01T07:00:00.000Z");
});
