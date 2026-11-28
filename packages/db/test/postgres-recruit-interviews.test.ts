import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { organizationStoreReadDecision, organizationStoreWriteDecision } from "@studenthub/organizations";
import { PostgresAuthzStore, PostgresOrganizationStoresStore, PostgresRecruitInterviewsStore, PostgresRecruitPipelineStore, PostgresRecruitRequestsStore, runMigrations } from "@studenthub/db";
import {
jobCandidateDecision,   evaluationAllowed, interviewCompanyDecision, internalNoteDecision, interviewOutbox, interviewStageAllowed, interviewTransitionAllowed, pipelineAssignDecision, pipelineAuthority, pipelineLeadDecision, pipelineRecruiterEligible, pipelineTransitionAllowed,
  recruitStaffDecision, requestAcceptsCards, requestCreateDecision, requestReadDecision, requestStatusAfterPipeline, requestTransitionAllowed, requestTransitionDecision,
} from "../../recruit/src/index.js";
import { PostgresAccessPausesStore } from "@studenthub/db";
import { revokeDuring, whileUncommitted } from "./recruit-races.js";

const URL = process.env.DATABASE_URL ?? "";
const OPS_ORG = `rec6-ops-${randomUUID()}`;
const OPS = [OPS_ORG];
let pool: pg.Pool, authz: PostgresAuthzStore, stores: PostgresOrganizationStoresStore, requests: PostgresRecruitRequestsStore, pipeline: PostgresRecruitPipelineStore, interviews: PostgresRecruitInterviewsStore;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: OPS_ORG, name: "Operator" }));
  stores = new PostgresOrganizationStoresStore({ pool, writeDecision: organizationStoreWriteDecision, readDecision: organizationStoreReadDecision });
  requests = new PostgresRecruitRequestsStore({
    pool, createDecision: (r, o, a) => requestCreateDecision(r, o, a, OPS), readDecision: (r, o, a) => requestReadDecision(r, o, a, OPS),
    transitionDecision: (r, o, a) => requestTransitionDecision(r, o, a, OPS), staffDecision: (r) => recruitStaffDecision(r, OPS), transitionAllowed: requestTransitionAllowed, managedStores: async () => [], paused: (ids: readonly string[]) => new PostgresAccessPausesStore({ pool }).paused(ids), pipelineAuthority: (p, a, r) => pipelineAuthority(p, a, pipelineLeadDecision(r, OPS), pipelineRecruiterEligible(r, OPS)),
  });
  pipeline = new PostgresRecruitPipelineStore({
    pool, assignDecision: (r) => pipelineAssignDecision(r, OPS), leadDecision: (r) => pipelineLeadDecision(r, OPS), recruiterEligible: (r) => pipelineRecruiterEligible(r, OPS), candidateDecision: jobCandidateDecision,
    authority: pipelineAuthority, transitionAllowed: pipelineTransitionAllowed, acceptsCards: requestAcceptsCards, requestStatusAfter: requestStatusAfterPipeline,
    placement: { placeFromRecruit: async () => ({ kind: "refused", code: "work_unavailable" }) }, operatorOrgIds: OPS,
  });
  interviews = new PostgresRecruitInterviewsStore({
    pool, companyDecision: (r, o, a) => interviewCompanyDecision(r, o, a, OPS), staffDecision: (r) => recruitStaffDecision(r, OPS), leadDecision: (r) => pipelineLeadDecision(r, OPS), recruiterEligible: (r) => pipelineRecruiterEligible(r, OPS),
    authority: pipelineAuthority, internalDecision: (r) => internalNoteDecision(r, OPS), stageAllowed: interviewStageAllowed, transitionAllowed: interviewTransitionAllowed,
    evaluationAllowed, outbox: interviewOutbox, paused: (ids: readonly string[]) => new PostgresAccessPausesStore({ pool }).paused(ids),
  });
});
after(async () => pool.end());

async function person(grants: { orgId: string; role: string; scope: "self" | "subtree" }[] = [], displayName?: string) {
  const id = `rec6-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid`, ...(displayName ? { displayName } : {}) }));
  // A person with no other grant is a candidate (candidate:self): only candidates are suggested or invited.
  await authz.grantMany(id, grants.length ? grants : [{ orgId: OPS_ORG, role: "candidate", scope: "self" }]);
  return id;
}
async function setup() {
  const orgId = `rec6-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: orgId, name: "Sultan Co", parentOrgId: OPS_ORG }));
  const owner = await person([{ orgId, role: "org-owner", scope: "self" }]);
  const storeId = ((await stores.create(owner, orgId, { name: "Avenues", location: null, brandId: null, mallId: null })) as { storeId: string }).storeId;
  const requestId = ((await requests.create(owner, orgId, { storeId, positionTitle: "Cashier", description: "d", compensationText: "3 KWD an hour", positionType: "part_time", headcount: 2, periodStart: "2026-12-01", periodEnd: "2026-12-31", payModel: "hourly", gender: "any", location: null, priority: 0, draft: false })) as { requestId: string }).requestId;
  const staff = await person([{ orgId: OPS_ORG, role: "staff", scope: "subtree" }]);
  const recruiter = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }], "Rami Recruiter");
  const other = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }]);
  const stranger = await person();
  await pipeline.assign(staff, requestId, recruiter);
  const noor = await person([], "Noor");
  const cardId = ((await pipeline.addCard(recruiter, requestId, noor)) as { cardId: string }).cardId;
  return { orgId, owner, requestId, staff, recruiter, other, stranger, noor, cardId };
}
const at = new Date(Date.now() + 86_400_000).toISOString();
const fields = (cardId: string) => ({ cardId, scheduledAt: at, durationMinutes: 30, mode: "in_person" as const, location: "Avenues, gate 3" });
const outbox = async (subject: string) => (await pool.query<{ kind: string; recipient_principal_id: string }>("SELECT kind, recipient_principal_id FROM recruit_outbox WHERE subject_id = $1 ORDER BY id", [subject])).rows.map((r) => [r.kind, r.recipient_principal_id]);

test("REC6_SCHEDULE the company and the assigned recruiter schedule for a live stage; others cannot; the person hears", async () => {
  const s = await setup();
  assert.deepEqual(await interviews.schedule(s.recruiter, s.requestId, fields(s.cardId)), { kind: "stage_refused", stage: "suggested" }, "a suggestion is contacted first");
  assert.equal((await pipeline.move(s.recruiter, s.cardId, "contacted")).kind, "moved");
  for (const who of [s.other, s.stranger, s.noor, s.staff]) assert.deepEqual(await interviews.schedule(who, s.requestId, fields(s.cardId)), { kind: "not_found" }, "neither another recruiter, a stranger, the person nor unassigned staff");
  assert.deepEqual(await interviews.schedule(s.owner, randomUUID(), fields(s.cardId)), { kind: "not_found" }, "the card must belong to the request");
  const byOwner = await interviews.schedule(s.owner, s.requestId, fields(s.cardId));
  assert.equal(byOwner.kind, "scheduled");
  const byRecruiter = await interviews.schedule(s.recruiter, s.requestId, fields(s.cardId));
  assert.equal(byRecruiter.kind, "scheduled");
  const id = (byOwner as { interviewId: string }).interviewId;
  assert.deepEqual(await outbox(id), [["interview.scheduled", s.noor]]);
  const page = (await interviews.forRequest(s.owner, s.requestId))!;
  assert.deepEqual([page.interviews.length, page.canWrite, page.seesInternal, page.cards.map((c) => [c.person_name, c.stage])], [2, true, false, [["Noor", "contacted"]]]);
  assert.equal((await interviews.forRequest(s.staff, s.requestId))!.canWrite, false, "operator staff read every request");
  assert.equal(await interviews.forRequest(s.stranger, s.requestId), null);
  assert.equal(await interviews.forRequest(s.other, s.requestId), null);
  await assert.rejects(pool.query("UPDATE recruit_interviews SET scheduled_at = scheduled_at + interval '1 hour' WHERE id = $1", [id]), /not rewritten/);
  await assert.rejects(pool.query("DELETE FROM recruit_interviews WHERE id = $1", [id]), /kept/);
});

test("REC6_EVALUATE the first evaluation completes; a correction is a new version; internal notes stay with operator staff", async () => {
  const s = await setup();
  await pipeline.move(s.recruiter, s.cardId, "contacted");
  const id = ((await interviews.schedule(s.owner, s.requestId, fields(s.cardId))) as { interviewId: string }).interviewId;
  assert.deepEqual(await interviews.evaluate(s.owner, id, { outcome: "passed", rating: 4, sharedNote: "Good", internalNote: "secret" }), { kind: "internal_note_refused" });
  assert.deepEqual(await interviews.evaluate(s.stranger, id, { outcome: "passed", rating: 4, sharedNote: null, internalNote: null }), { kind: "not_found" });
  assert.deepEqual(await interviews.evaluate(s.recruiter, id, { outcome: "passed", rating: 4, sharedNote: "Good", internalNote: "Strong, but late" }), { kind: "evaluated", version: 1 });
  assert.deepEqual(await interviews.evaluate(s.owner, id, { outcome: "passed", rating: 5, sharedNote: "Very good", internalNote: null }), { kind: "evaluated", version: 2 });
  const owner = (await interviews.forRequest(s.owner, s.requestId))!.interviews[0]!;
  assert.deepEqual([owner.status, owner.outcome, owner.rating, owner.shared_note, owner.internal_note, owner.evaluation_version], ["completed", "passed", 5, "Very good", null, 2]);
  const staff = (await interviews.forRequest(s.recruiter, s.requestId))!.interviews[0]!;
  assert.equal(staff.internal_note, "Strong, but late", "the company's correction kept the staff note it cannot see");
  assert.deepEqual(await interviews.cancel(s.owner, id), { kind: "refused", status: "completed" });
  await assert.rejects(pool.query("UPDATE recruit_interview_evaluations SET rating = 1 WHERE interview_id = $1", [id]), /versioned/);
  await assert.rejects(pool.query("UPDATE recruit_interviews SET status = 'scheduled', closed_at = NULL WHERE id = $1", [id]), /not allowed/);
  const mine = await interviews.mine(s.noor);
  assert.deepEqual(mine.map((r) => [r.org_name, r.store_name, r.position_title, r.status, r.outcome]), [["Sultan Co", "Avenues", "Cashier", "completed", "passed"]]);
  assert.equal("rating" in mine[0]! || "shared_note" in mine[0]!, false, "the person never reads a rating or a note");
});

test("REC6_CANCEL a scheduled interview is cancelled once; it takes no evaluation; the person hears", async () => {
  const s = await setup();
  await pipeline.move(s.recruiter, s.cardId, "contacted");
  const id = ((await interviews.schedule(s.recruiter, s.requestId, fields(s.cardId))) as { interviewId: string }).interviewId;
  assert.deepEqual(await interviews.cancel(s.other, id), { kind: "not_found" });
  assert.deepEqual(await interviews.cancel(s.owner, id), { kind: "cancelled" });
  assert.deepEqual(await interviews.cancel(s.owner, id), { kind: "refused", status: "cancelled" });
  assert.deepEqual(await interviews.evaluate(s.recruiter, id, { outcome: "no_show", rating: null, sharedNote: null, internalNote: null }), { kind: "refused", status: "cancelled" });
  assert.deepEqual(await outbox(id), [["interview.scheduled", s.noor], ["interview.cancelled", s.noor]]);
  assert.deepEqual(await interviews.cancel(s.owner, randomUUID()), { kind: "not_found" });
});

test("REC6_REVOKE_RACE the assigned recruiter or the company losing the grant while scheduling, cancelling or evaluating is refused", async () => {
  const s = await setup();
  assert.equal((await pipeline.move(s.recruiter, s.cardId, "contacted")).kind, "moved");
  const id = ((await interviews.schedule(s.recruiter, s.requestId, fields(s.cardId))) as { interviewId: string }).interviewId;
  assert.deepEqual(await revokeDuring(pool, s.owner, () => interviews.evaluate(s.owner, id, { outcome: "passed", rating: 4, sharedNote: null, internalNote: null })), { kind: "not_found" });
  assert.deepEqual(await revokeDuring(pool, s.recruiter, () => interviews.cancel(s.recruiter, id)), { kind: "not_found" });
  assert.deepEqual(await interviews.schedule(s.recruiter, s.requestId, fields(s.cardId)), { kind: "not_found" }, "still assigned, but no longer a recruiter");
  assert.equal((await pool.query<{ status: string }>("SELECT status FROM recruit_interviews WHERE id = $1::uuid", [id])).rows[0]!.status, "scheduled");
  assert.equal((await pool.query("SELECT 1 FROM recruit_interview_evaluations WHERE interview_id = $1::uuid", [id])).rowCount, 0);
});

test("REC6_STALE_FORM a correction from a form that showed an older version is refused; the current version stands", async () => {
  const s = await setup();
  await pipeline.move(s.recruiter, s.cardId, "contacted");
  const id = ((await interviews.schedule(s.owner, s.requestId, fields(s.cardId))) as { interviewId: string }).interviewId;
  assert.deepEqual(await interviews.evaluate(s.recruiter, id, { outcome: "not_passed", rating: 2, sharedNote: "Late", internalNote: "Twice late", expectedVersion: 0 }), { kind: "evaluated", version: 1 });
  assert.deepEqual(await interviews.evaluate(s.owner, id, { outcome: "not_passed", rating: 2, sharedNote: "Late, apologised", internalNote: null, expectedVersion: 1 }), { kind: "evaluated", version: 2 });
  assert.deepEqual(await interviews.evaluate(s.recruiter, id, { outcome: "passed", rating: 5, sharedNote: null, internalNote: null, expectedVersion: 1 }), { kind: "stale", version: 2 });
  const now = (await interviews.forRequest(s.recruiter, s.requestId))!.interviews[0]!;
  assert.deepEqual([now.outcome, now.rating, now.shared_note, now.internal_note, now.evaluation_version], ["not_passed", 2, "Late, apologised", "Twice late", 2], "the company's correction kept the staff note");
});

test("REC6_TREE_RACE a reparent that removes the company caller's ancestor authority while an interview write is in flight refuses it", async () => {
  const s = await setup();
  await pipeline.move(s.recruiter, s.cardId, "contacted");
  // The company sits under a holding group; the holding owner's subtree grant is what authorises them.
  const group = `rec6-group-${randomUUID()}`, elsewhere = `rec6-elsewhere-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: group, name: "Group", parentOrgId: OPS_ORG }));
  await authz.upsertOrganization(createOrganization({ id: elsewhere, name: "Elsewhere", parentOrgId: OPS_ORG }));
  const middle = `rec6-middle-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: middle, name: "Middle", parentOrgId: group }));
  await pool.query("UPDATE organizations SET parent_org_id = $2 WHERE id = $1", [s.orgId, middle]);
  const holder = await person([{ orgId: group, role: "org-owner", scope: "subtree" }]);
  const reparent = `SELECT pg_advisory_xact_lock(hashtext('studenthub:organizations:tree')); UPDATE organizations SET parent_org_id = '${elsewhere}' WHERE id = '${middle}'`;
  assert.deepEqual(await whileUncommitted(pool, reparent, [], () => interviews.schedule(holder, s.requestId, fields(s.cardId))), { kind: "not_found" });
  assert.equal((await pool.query("SELECT 1 FROM recruit_interviews WHERE card_id = $1", [s.cardId])).rowCount, 0);
});

test("REC6_PAUSED a paused person's interviews and card are hidden from the company; internal callers still see them", async () => {
  const s = await setup();
  assert.equal((await pipeline.move(s.recruiter, s.cardId, "contacted")).kind, "moved");
  assert.equal((await interviews.schedule(s.owner, s.requestId, fields(s.cardId))).kind, "scheduled");
  const pauses = new PostgresAccessPausesStore({ pool });
  const change = (action: "pause" | "resume") => pauses.apply({ callerId: s.staff, request: { targetPrincipalId: s.noor, action, reason: "test pause" }, decide: () => ({ kind: "apply" }) });
  assert.equal((await change("pause")).kind, "paused");
  const company = (await interviews.forRequest(s.owner, s.requestId))!;
  assert.deepEqual([company.interviews.length, company.cards.length], [0, 0], "the company sees neither the interview nor the card");
  for (const who of [s.staff, s.recruiter]) {
    const page = (await interviews.forRequest(who, s.requestId))!;
    assert.deepEqual([page.interviews.length, page.cards.length], [1, 1]);
  }
  // The paused port is asked after the snapshot's connection is released: a one-connection pool still answers.
  const small = new pg.Pool({ connectionString: URL, max: 1, connectionTimeoutMillis: 2000 });
  try {
    const one = new PostgresRecruitInterviewsStore({ ...interviews.options, pool: small, paused: (ids: readonly string[]) => new PostgresAccessPausesStore({ pool: small }).paused(ids) });
    const within = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the page waited for a second connection")), 5000).unref())]);
    assert.deepEqual((await within(one.forRequest(s.owner, s.requestId)))!.interviews.length, 0);
  } finally { await small.end(); }
  assert.equal((await change("resume")).kind, "resumed");
  assert.equal((await interviews.forRequest(s.owner, s.requestId))!.interviews.length, 1);
});

test("REC6_ORGANIZATION a company's interviews page: staff and the company read it, a page at a time; others get null; paused people hidden from the company", async () => {
  const s = await setup();
  await pipeline.move(s.recruiter, s.cardId, "contacted");
  const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const first = ((await interviews.schedule(s.owner, s.requestId, fields(s.cardId))) as { interviewId: string }).interviewId;
  const second = ((await interviews.schedule(s.owner, s.requestId, { ...fields(s.cardId), scheduledAt: later, mode: "video" })) as { interviewId: string }).interviewId;
  await interviews.evaluate(s.recruiter, first, { outcome: "passed", rating: 4, sharedNote: "Good", internalNote: "Strong" });
  const owner = (await interviews.forOrganization(s.owner, s.orgId))!;
  assert.equal(owner.org_name, "Sultan Co");
  assert.deepEqual(owner.interviews.map((r) => [r.id, r.request_id, r.position_title, r.store_name, r.person_name, r.mode, r.status, r.outcome]),
    [[second, s.requestId, "Cashier", "Avenues", "Noor", "video", "scheduled", null], [first, s.requestId, "Cashier", "Avenues", "Noor", "in_person", "completed", "passed"]], "latest scheduled first");
  assert.equal(Object.keys(owner.interviews[0]!).some((k) => /rating|note|location/.test(k)), false, "never a rating, a note or a location");
  assert.equal((await interviews.forOrganization(s.staff, s.orgId))!.interviews.length, 2, "operator staff read every company");
  for (const who of [s.recruiter, s.other, s.stranger, s.noor]) assert.equal(await interviews.forOrganization(who, s.orgId), null, "a pipeline recruiter, a stranger and the person do not");
  const elsewhere = await setup();
  assert.equal(await interviews.forOrganization(elsewhere.owner, s.orgId), null, "another company does not");
  assert.equal(await interviews.forOrganization(s.owner, `rec6-missing-${randomUUID()}`), null);
  assert.equal(await interviews.forOrganization(s.owner, s.orgId, 0), null);
  const one = (await interviews.forOrganization(s.owner, s.orgId, 1, 1))!, two = (await interviews.forOrganization(s.owner, s.orgId, 2, 1))!;
  assert.deepEqual([one.interviews.map((r) => r.id), one.more, two.interviews.map((r) => r.id), two.more], [[second], true, [first], false]);
  assert.deepEqual((await interviews.forOrganization(s.owner, s.orgId, 3, 1))!.interviews, []);
  const pauses = new PostgresAccessPausesStore({ pool });
  const change = (action: "pause" | "resume") => pauses.apply({ callerId: s.staff, request: { targetPrincipalId: s.noor, action, reason: "test pause" }, decide: () => ({ kind: "apply" }) });
  assert.equal((await change("pause")).kind, "paused");
  assert.equal((await interviews.forOrganization(s.owner, s.orgId))!.interviews.length, 0, "the company does not see a paused person");
  assert.equal((await interviews.forOrganization(s.staff, s.orgId))!.interviews.length, 2, "internal callers still do");
  assert.equal((await change("resume")).kind, "resumed");
});

test("REC6_STAFF_LIST operator staff read every company's interviews with the outcome and rating, a page at a time; nobody else does", async () => {
  const s = await setup(), t = await setup();
  await pipeline.move(s.recruiter, s.cardId, "contacted"); await pipeline.move(t.recruiter, t.cardId, "contacted");
  const far = new Date(Date.now() + 400 * 86_400_000).toISOString(), farther = new Date(Date.now() + 401 * 86_400_000).toISOString();
  const mine = ((await interviews.schedule(s.owner, s.requestId, { ...fields(s.cardId), scheduledAt: far })) as { interviewId: string }).interviewId;
  const theirs = ((await interviews.schedule(t.owner, t.requestId, { ...fields(t.cardId), scheduledAt: farther, mode: "phone" })) as { interviewId: string }).interviewId;
  await interviews.evaluate(s.recruiter, mine, { outcome: "not_passed", rating: 2, sharedNote: "Late", internalNote: "Twice late" });
  const list = (await interviews.forStaff(s.staff, 1, 200))!;
  const ours = list.interviews.filter((r) => r.id === mine || r.id === theirs);
  assert.deepEqual(ours.map((r) => [r.id, r.org_id, r.org_name, r.store_name, r.position_title, r.person_name, r.mode, r.status, r.outcome, r.rating]),
    [[theirs, t.orgId, "Sultan Co", "Avenues", "Cashier", "Noor", "phone", "scheduled", null, null], [mine, s.orgId, "Sultan Co", "Avenues", "Cashier", "Noor", "in_person", "completed", "not_passed", 2]], "both companies, latest first");
  assert.equal(Object.keys(ours[0]!).some((k) => /note|location/.test(k)), false, "never a note or a location");
  for (const who of [s.owner, s.recruiter, s.stranger, s.noor]) assert.equal(await interviews.forStaff(who), null, "only operator staff");
  assert.equal(await interviews.forStaff(s.staff, 0), null);
  // Earlier runs leave interviews in the shared database: page by one around this run's rows.
  const at = list.interviews.findIndex((r) => r.id === theirs) + 1, next = list.interviews.findIndex((r) => r.id === mine) + 1;
  const one = (await interviews.forStaff(s.staff, at, 1))!, two = (await interviews.forStaff(s.staff, next, 1))!;
  assert.deepEqual([one.interviews.map((r) => r.id), one.more, two.interviews.map((r) => r.id), two.more], [[theirs], true, [mine], true], "a page at a time, latest first");
});

test("REC6_ORGANIZATION_PAUSED_PAGES paused people are hidden before paging: no short or empty company page, no Earlier link past them", async () => {
  const s = await setup();
  const sara = await person([], "Sara");
  const saraCard = ((await pipeline.addCard(s.recruiter, s.requestId, sara)) as { cardId: string }).cardId;
  await pipeline.move(s.recruiter, s.cardId, "contacted"); await pipeline.move(s.recruiter, saraCard, "contacted");
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
  const newest = ((await interviews.schedule(s.owner, s.requestId, { ...fields(s.cardId), scheduledAt: day(5) })) as { interviewId: string }).interviewId;
  const middle = ((await interviews.schedule(s.owner, s.requestId, { ...fields(saraCard), scheduledAt: day(4) })) as { interviewId: string }).interviewId;
  const oldest = ((await interviews.schedule(s.owner, s.requestId, { ...fields(s.cardId), scheduledAt: day(3) })) as { interviewId: string }).interviewId;
  const pauses = new PostgresAccessPausesStore({ pool });
  const change = (who: string, action: "pause" | "resume") => pauses.apply({ callerId: s.staff, request: { targetPrincipalId: who, action, reason: "test pause" }, decide: () => ({ kind: "apply" }) });
  assert.equal((await change(s.noor, "pause")).kind, "paused");
  const first = (await interviews.forOrganization(s.owner, s.orgId, 1, 1))!;
  assert.deepEqual([first.interviews.map((r) => r.id), first.more], [[middle], false], "the first company page holds the visible row and no Earlier link past paused rows");
  assert.deepEqual((await interviews.forOrganization(s.owner, s.orgId, 2, 1))!.interviews, [], "nothing visible past it");
  const staff = (await interviews.forOrganization(s.staff, s.orgId, 1, 2))!;
  assert.deepEqual([staff.interviews.map((r) => r.id), staff.more], [[newest, middle], true], "internal callers still page through paused people");
  assert.equal((await change(sara, "pause")).kind, "paused");
  const none = (await interviews.forOrganization(s.owner, s.orgId, 1, 1))!;
  assert.deepEqual([none.interviews, none.more], [[], false], "all paused: an empty first page with no Earlier link");
  assert.deepEqual((await interviews.forOrganization(s.staff, s.orgId, 2, 2))!.interviews.map((r) => r.id), [oldest]);
  await change(s.noor, "resume"); await change(sara, "resume");
});
