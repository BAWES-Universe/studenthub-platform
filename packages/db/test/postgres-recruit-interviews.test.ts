import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { organizationStoreReadDecision, organizationStoreWriteDecision } from "@studenthub/organizations";
import { PostgresAuthzStore, PostgresOrganizationStoresStore, PostgresRecruitInterviewsStore, PostgresRecruitPipelineStore, PostgresRecruitRequestsStore, runMigrations } from "@studenthub/db";
import {
  evaluationAllowed, interviewCompanyDecision, internalNoteDecision, interviewOutbox, interviewStageAllowed, interviewTransitionAllowed, pipelineAssignDecision, pipelineAuthority, pipelineLeadDecision, pipelineRecruiterEligible, pipelineTransitionAllowed,
  recruitStaffDecision, requestAcceptsCards, requestCreateDecision, requestReadDecision, requestStatusAfterPipeline, requestTransitionAllowed, requestTransitionDecision,
} from "../../recruit/src/index.js";

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
    transitionDecision: (r, o, a) => requestTransitionDecision(r, o, a, OPS), staffDecision: (r) => recruitStaffDecision(r, OPS), transitionAllowed: requestTransitionAllowed,
  });
  pipeline = new PostgresRecruitPipelineStore({
    pool, assignDecision: (r) => pipelineAssignDecision(r, OPS), leadDecision: (r) => pipelineLeadDecision(r, OPS), recruiterEligible: (r) => pipelineRecruiterEligible(r, OPS),
    authority: pipelineAuthority, transitionAllowed: pipelineTransitionAllowed, acceptsCards: requestAcceptsCards, requestStatusAfter: requestStatusAfterPipeline,
    placement: { placeFromRecruit: async () => ({ kind: "refused", code: "work_unavailable" }) }, operatorOrgIds: OPS,
  });
  interviews = new PostgresRecruitInterviewsStore({
    pool, companyDecision: (r, o, a) => interviewCompanyDecision(r, o, a, OPS), staffDecision: (r) => recruitStaffDecision(r, OPS), leadDecision: (r) => pipelineLeadDecision(r, OPS),
    authority: pipelineAuthority, internalDecision: (r) => internalNoteDecision(r, OPS), stageAllowed: interviewStageAllowed, transitionAllowed: interviewTransitionAllowed,
    evaluationAllowed, outbox: interviewOutbox,
  });
});
after(async () => pool.end());

async function person(grants: { orgId: string; role: string; scope: "self" | "subtree" }[] = [], displayName?: string) {
  const id = `rec6-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid`, ...(displayName ? { displayName } : {}) }));
  if (grants.length) await authz.grantMany(id, grants);
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
