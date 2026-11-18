import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { organizationStoreReadDecision, organizationStoreWriteDecision } from "@studenthub/organizations";
import { PostgresAuthzStore, PostgresOrganizationStoresStore, PostgresRecruitPipelineStore, PostgresRecruitRequestApplicationsStore, PostgresRecruitRequestsStore, runMigrations } from "@studenthub/db";
import { PostgresAccessPausesStore } from "@studenthub/db";
import { revokeDuring, rowFreeWhileTreeHeld } from "./recruit-races.js";
import {
  acceptCardEffect, interviewCompanyDecision, jobCandidateDecision, pipelineAssignDecision, pipelineAuthority, pipelineLeadDecision, pipelineRecruiterEligible, pipelineTransitionAllowed, recruitStaffDecision,
  requestAcceptsCards, requestApplicationOutbox, requestApplicationTransitionAllowed, requestCreateDecision, requestReadDecision, requestStatusAfterPipeline, requestTakesApplications,
  requestTransitionAllowed, requestTransitionDecision,
} from "../../recruit/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
const OPS_ORG = `rec7b-ops-${randomUUID()}`;
const OPS = [OPS_ORG];
let pool: pg.Pool, authz: PostgresAuthzStore, stores: PostgresOrganizationStoresStore, requests: PostgresRecruitRequestsStore, pipeline: PostgresRecruitPipelineStore, applications: PostgresRecruitRequestApplicationsStore;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: OPS_ORG, name: "Operator" }));
  stores = new PostgresOrganizationStoresStore({ pool, writeDecision: organizationStoreWriteDecision, readDecision: organizationStoreReadDecision });
  requests = new PostgresRecruitRequestsStore({
    pool, createDecision: (r, o, a) => requestCreateDecision(r, o, a, OPS), readDecision: (r, o, a) => requestReadDecision(r, o, a, OPS),
    transitionDecision: (r, o, a) => requestTransitionDecision(r, o, a, OPS), staffDecision: (r) => recruitStaffDecision(r, OPS), transitionAllowed: requestTransitionAllowed, managedStores: async () => [], paused: (ids: readonly string[]) => new PostgresAccessPausesStore({ pool }).paused(ids),
  });
  pipeline = new PostgresRecruitPipelineStore({
    pool, assignDecision: (r) => pipelineAssignDecision(r, OPS), leadDecision: (r) => pipelineLeadDecision(r, OPS), recruiterEligible: (r) => pipelineRecruiterEligible(r, OPS), candidateDecision: jobCandidateDecision,
    authority: pipelineAuthority, transitionAllowed: pipelineTransitionAllowed, acceptsCards: requestAcceptsCards, requestStatusAfter: requestStatusAfterPipeline,
    placement: { placeFromRecruit: async () => ({ kind: "refused", code: "work_unavailable" }) }, operatorOrgIds: OPS,
  });
  applications = new PostgresRecruitRequestApplicationsStore({
    pool, companyDecision: (r, o, a) => interviewCompanyDecision(r, o, a, OPS), staffDecision: (r) => recruitStaffDecision(r, OPS), leadDecision: (r) => pipelineLeadDecision(r, OPS),
    recruiterEligible: (r) => pipelineRecruiterEligible(r, OPS), candidateDecision: jobCandidateDecision,
    authority: pipelineAuthority, takesApplications: requestTakesApplications, transitionAllowed: requestApplicationTransitionAllowed, acceptCardEffect,
    requestStatusAfter: requestStatusAfterPipeline, outbox: requestApplicationOutbox, pageSize: 2, paused: (ids: readonly string[]) => new PostgresAccessPausesStore({ pool }).paused(ids),
  });
});
after(async () => pool.end());

async function person(grants: { orgId: string; role: string; scope: "self" | "subtree" }[] = [], displayName?: string) {
  const id = `rec7b-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid`, ...(displayName ? { displayName } : {}) }));
  // A person with no other grant is a candidate (candidate:self): only candidates browse and apply.
  await authz.grantMany(id, grants.length ? grants : [{ orgId: OPS_ORG, role: "candidate", scope: "self" }]);
  return id;
}
async function setup(title: string, o: { draft?: boolean; positionType?: "full_time" | "part_time" } = {}) {
  const orgId = `rec7b-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: orgId, name: "Sultan Co", parentOrgId: OPS_ORG }));
  const owner = await person([{ orgId, role: "org-owner", scope: "self" }]);
  const storeId = ((await stores.create(owner, orgId, { name: "Avenues", location: null, brandId: null, mallId: null })) as { storeId: string }).storeId;
  const make = async (t: string, draft = o.draft ?? false) => ((await requests.create(owner, orgId, { storeId, positionTitle: t, description: "Day shifts", compensationText: "3 KWD an hour", positionType: o.positionType ?? "part_time", headcount: 2, periodStart: "2026-12-01", periodEnd: "2026-12-31", payModel: "hourly", gender: "male", location: null, priority: 0, draft })) as { requestId: string }).requestId;
  const requestId = await make(title);
  const staff = await person([{ orgId: OPS_ORG, role: "staff", scope: "subtree" }]);
  const recruiter = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }]);
  return { orgId, owner, requestId, staff, recruiter, make };
}
const outbox = async (subject: string) => (await pool.query<{ kind: string; recipient_principal_id: string }>("SELECT kind, recipient_principal_id FROM recruit_outbox WHERE subject_id = $1 ORDER BY id", [subject])).rows.map((r) => [r.kind, r.recipient_principal_id]);
const status = async (requestId: string) => (await pool.query<{ status: string }>("SELECT status FROM recruit_requests WHERE id = $1", [requestId])).rows[0]!.status;

test("REC7B_APPLY people browse open requests of live companies and apply once; drafts, closed requests and inactive companies take none", async () => {
  const tag = `rec7b${randomUUID().slice(0, 8)}`, s = await setup(`Cashier ${tag}`), noor = await person([], "Noor"), sara = await person([], "Sara");
  const second = await s.make(`Barista ${tag}`), draft = await s.make(`Hidden ${tag}`, true);
  const board = async (who: string, q: Partial<{ applied: boolean; page: number; positionType: "full_time" | "part_time" | null }> = {}) => (await applications.board(who, { q: tag, positionType: null, applied: false, page: 1, ...q }))!;
  const first = await board(noor);
  assert.deepEqual([first.total, first.requests.map((r) => r.position_title)], [2, [`Barista ${tag}`, `Cashier ${tag}`]], "newest first; the draft is hidden; no gender filter (the request asks for male)");
  assert.equal((await board(noor, { positionType: "full_time" })).total, 0);
  assert.equal((await applications.openRequest(noor, draft)), null);
  assert.deepEqual(await applications.apply(noor, draft), { kind: "not_found" });
  const applied = await applications.apply(noor, s.requestId);
  assert.equal(applied.kind, "applied");
  const id = (applied as { applicationId: string }).applicationId;
  assert.deepEqual(await applications.apply(noor, s.requestId), { kind: "duplicate", applicationId: id });
  assert.deepEqual(await outbox(id), [], "no recruiter assigned yet: nobody is notified");
  assert.deepEqual((await board(noor)).requests.map((r) => r.id), [second], "an applied request leaves the board");
  assert.deepEqual((await board(noor, { applied: true })).requests.map((r) => [r.id, r.application_status]), [[s.requestId, "applied"]]);
  assert.equal((await applications.openRequest(noor, s.requestId))!.application_id, id);

  await pipeline.assign(s.staff, second, s.recruiter);
  const saraApplied = (await applications.apply(sara, second)) as { applicationId: string };
  assert.deepEqual(await outbox(saraApplied.applicationId), [["request_application.received", s.recruiter]]);

  assert.equal((await requests.transition(s.owner, second, "closed", "cancelled")).kind, "transitioned");
  assert.deepEqual(await applications.apply(noor, second), { kind: "request_not_open" });
  assert.equal((await applications.openRequest(noor, second)), null, "a closed request is gone unless you applied");
  assert.notEqual((await applications.openRequest(sara, second)), null);

  const live = await setup(`Packer ${tag}`);
  await pool.query("INSERT INTO organization_status_overrides(org_id, status) VALUES($1, 'inactive')", [live.orgId]);
  assert.equal((await board(noor)).requests.some((r) => r.id === live.requestId), false, "an inactive company does not advertise");
  assert.deepEqual(await applications.apply(noor, live.requestId), { kind: "not_found" });
  await assert.rejects(pool.query("DELETE FROM recruit_request_applications WHERE id = $1", [id]), /kept/);
});

test("REC7B_DECIDE the company or the request's recruiter accepts an applicant onto the pipeline or rejects them; staff read; others see nothing", async () => {
  const tag = `rec7b${randomUUID().slice(0, 8)}`, s = await setup(`Cashier ${tag}`), noor = await person([], "Noor"), sara = await person([], "Sara"), stranger = await person();
  await pipeline.assign(s.staff, s.requestId, s.recruiter);
  const a = ((await applications.apply(noor, s.requestId)) as { applicationId: string }).applicationId;
  const b = ((await applications.apply(sara, s.requestId)) as { applicationId: string }).applicationId;
  const company = (await applications.forRequest(s.owner, s.requestId))!;
  assert.deepEqual([company.canDecide, company.applications.map((x) => [x.person_name, x.status, x.card_id])], [true, [["Sara", "applied", null], ["Noor", "applied", null]]]);
  assert.equal((await applications.forRequest(s.staff, s.requestId))!.canDecide, false, "staff read; the pipeline's authority decides");
  assert.equal(await applications.forRequest(stranger, s.requestId), null);
  assert.equal(await applications.forRequest(noor, s.requestId), null, "an applicant does not see the others");
  for (const who of [stranger, s.staff, noor]) assert.deepEqual(await applications.decide(who, a, "accepted"), { kind: "not_found" });

  const accepted = await applications.decide(s.owner, a, "accepted");
  assert.equal(accepted.kind, "decided");
  const card = (await pool.query<{ id: string; stage: string }>("SELECT id, stage FROM recruit_pipeline_cards WHERE request_id = $1 AND person_principal_id = $2", [s.requestId, noor])).rows[0]!;
  assert.deepEqual([card.stage, (accepted as { cardId: string }).cardId, await status(s.requestId)], ["contacted", card.id, "filling"]);
  assert.deepEqual(await applications.decide(s.recruiter, a, "rejected"), { kind: "refused", status: "accepted" });
  assert.deepEqual(await applications.decide(s.recruiter, b, "rejected"), { kind: "decided", status: "rejected", cardId: null });
  assert.deepEqual(await outbox(a), [["request_application.received", s.recruiter], ["request_application.accepted", noor]]);
  assert.deepEqual(await outbox(b), [["request_application.received", s.recruiter], ["request_application.rejected", sara]]);
  assert.deepEqual((await applications.forRequest(s.recruiter, s.requestId))!.applications.map((x) => [x.status, x.card_id]), [["rejected", null], ["accepted", card.id]]);
  await assert.rejects(pool.query("UPDATE recruit_request_applications SET status = 'applied', decided_at = NULL WHERE id = $1", [a]), /not allowed/);

  const withdrawn = await person([], "Wafa");
  const w = ((await applications.apply(withdrawn, s.requestId)) as { applicationId: string }).applicationId;
  const wCard = ((await pipeline.addCard(s.recruiter, s.requestId, withdrawn)) as { cardId: string }).cardId;
  assert.equal((await pipeline.move(s.recruiter, wCard, "withdrawn")).kind, "moved");
  assert.deepEqual(await applications.decide(s.owner, w, "accepted"), { kind: "card_withdrawn" }, "a withdrawn person is not put back by an old application");
});

test("REC7B_CANDIDATES_ONLY the open-request board, a request's page and applying are for candidates; company and staff accounts get nothing", async () => {
  const tag = `rec7b${randomUUID().slice(0, 8)}`, s = await setup(`Cashier ${tag}`);
  for (const who of [s.owner, s.staff, s.recruiter]) {
    assert.equal(await applications.board(who, { q: tag, positionType: null, applied: false, page: 1 }), null, who);
    assert.equal(await applications.openRequest(who, s.requestId), null, who);
    assert.deepEqual(await applications.apply(who, s.requestId), { kind: "not_found" }, who);
  }
});

test("REC7B_REVOKE_RACE a candidate grant revoked before or during an apply or an acceptance refuses it; rejecting still works", async () => {
  const tag = `rec7b${randomUUID().slice(0, 8)}`, s = await setup(`Cashier ${tag}`);
  await pipeline.assign(s.staff, s.requestId, s.recruiter);
  const noor = await person([], "Noor");
  assert.deepEqual(await revokeDuring(pool, noor, () => applications.apply(noor, s.requestId)), { kind: "not_found" });
  assert.equal((await pool.query("SELECT 1 FROM recruit_request_applications WHERE request_id = $1", [s.requestId])).rowCount, 0);
  const sara = await person([], "Sara"), huda = await person([], "Huda");
  const a = ((await applications.apply(sara, s.requestId)) as { applicationId: string }).applicationId;
  const b = ((await applications.apply(huda, s.requestId)) as { applicationId: string }).applicationId;
  assert.deepEqual(await revokeDuring(pool, sara, () => applications.decide(s.owner, a, "accepted")), { kind: "person_unavailable" });
  assert.equal((await pool.query("SELECT 1 FROM recruit_pipeline_cards WHERE request_id = $1", [s.requestId])).rowCount, 0, "nobody joined the pipeline");
  assert.deepEqual(await applications.decide(s.owner, a, "rejected"), { kind: "decided", status: "rejected", cardId: null });
  assert.deepEqual(await revokeDuring(pool, s.recruiter, () => applications.decide(s.recruiter, b, "accepted")), { kind: "not_found" }, "the assigned recruiter loses authority with the grant");
});

test("REC7B_LOCK_ORDER a decision waiting on the organization tree holds no request row, so it cannot deadlock with apply and a grant change", async () => {
  const tag = `rec7b${randomUUID().slice(0, 8)}`, s = await setup(`Cashier ${tag}`);
  const noor = await person([], "Noor");
  const a = ((await applications.apply(noor, s.requestId)) as { applicationId: string }).applicationId;
  const r = await rowFreeWhileTreeHeld(pool, "SELECT 1 FROM recruit_requests WHERE id = $1 FOR UPDATE NOWAIT", [s.requestId], () => applications.decide(s.owner, a, "rejected"));
  assert.equal(r.rowFree, true, "the request row is free while the decision waits for the tree");
  assert.deepEqual(r.result, { kind: "decided", status: "rejected", cardId: null });
});

test("REC7B_PAUSED a paused applicant is hidden from the company; staff and the request's recruiter still see them", async () => {
  const tag = `rec7b${randomUUID().slice(0, 8)}`, s = await setup(`Cashier ${tag}`), noor = await person([], "Noor"), sara = await person([], "Sara");
  await pipeline.assign(s.staff, s.requestId, s.recruiter);
  for (const who of [noor, sara]) assert.equal((await applications.apply(who, s.requestId)).kind, "applied");
  const pauses = new PostgresAccessPausesStore({ pool });
  const change = (action: "pause" | "resume") => pauses.apply({ callerId: s.staff, request: { targetPrincipalId: noor, action, reason: "test pause" }, decide: () => ({ kind: "apply" }) });
  assert.equal((await change("pause")).kind, "paused");
  assert.deepEqual((await applications.forRequest(s.owner, s.requestId))!.applications.map((x) => x.person_name), ["Sara"]);
  for (const who of [s.staff, s.recruiter]) assert.deepEqual(new Set((await applications.forRequest(who, s.requestId))!.applications.map((x) => x.person_name)), new Set(["Noor", "Sara"]));
  // The paused port is asked after the snapshot's connection is released: a one-connection pool still answers.
  const small = new pg.Pool({ connectionString: URL, max: 1 });
  try {
    const one = new PostgresRecruitRequestApplicationsStore({ ...applications.options, pool: small, paused: (ids: readonly string[]) => new PostgresAccessPausesStore({ pool: small }).paused(ids) });
    const within = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the page waited for a second connection")), 5000).unref())]);
    assert.deepEqual((await within(one.forRequest(s.owner, s.requestId)))!.applications.map((x) => x.person_name), ["Sara"]);
  } finally { await small.end(); }
  assert.equal((await change("resume")).kind, "resumed");
  assert.equal((await applications.forRequest(s.owner, s.requestId))!.applications.length, 2);
});
