import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { organizationStoreReadDecision, organizationStoreWriteDecision } from "@studenthub/organizations";
import { PostgresAuthzStore, PostgresOrganizationStoresStore, PostgresRecruitPipelineStore, PostgresRecruitRequestsStore, runMigrations, type RecruitPlacementRequest, type RecruitPlacementResult } from "@studenthub/db";
import {
jobCandidateDecision,   pipelineAssignDecision, pipelineAuthority, pipelineLeadDecision, pipelineRecruiterEligible, pipelineTransitionAllowed, recruitStaffDecision,
  requestAcceptsCards, requestCreateDecision, requestReadDecision, requestStatusAfterPipeline, requestTransitionAllowed, requestTransitionDecision, type PipelineStage,
} from "../../recruit/src/index.js";
import { revokeDuring } from "./recruit-races.js";

const URL = process.env.DATABASE_URL ?? "";
const OPS_ORG = `rec2-ops-${randomUUID()}`;
const OPS = [OPS_ORG];
let pool: pg.Pool, authz: PostgresAuthzStore, stores: PostgresOrganizationStoresStore, requests: PostgresRecruitRequestsStore, pipeline: PostgresRecruitPipelineStore;
const placements: RecruitPlacementRequest[] = [];
let placementAnswer: (r: RecruitPlacementRequest) => Promise<RecruitPlacementResult> = async (r) => ({ kind: "placed", assignmentId: randomUUID(), created: !placements.slice(0, -1).some((p) => p.recruitCardId === r.recruitCardId) });

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: OPS_ORG, name: "Operator" }));
  stores = new PostgresOrganizationStoresStore({ pool, writeDecision: organizationStoreWriteDecision, readDecision: organizationStoreReadDecision });
  requests = new PostgresRecruitRequestsStore({
    pool, createDecision: (r, o, a) => requestCreateDecision(r, o, a, OPS), readDecision: (r, o, a) => requestReadDecision(r, o, a, OPS),
    transitionDecision: (r, o, a) => requestTransitionDecision(r, o, a, OPS), staffDecision: (r) => recruitStaffDecision(r, OPS), transitionAllowed: requestTransitionAllowed, managedStores: async () => [],
  });
  pipeline = new PostgresRecruitPipelineStore({
    pool, assignDecision: (r) => pipelineAssignDecision(r, OPS), leadDecision: (r) => pipelineLeadDecision(r, OPS), recruiterEligible: (r) => pipelineRecruiterEligible(r, OPS), candidateDecision: jobCandidateDecision,
    authority: pipelineAuthority, transitionAllowed: pipelineTransitionAllowed, acceptsCards: requestAcceptsCards, requestStatusAfter: requestStatusAfterPipeline,
    placement: { placeFromRecruit: async (_actor, r) => { placements.push(r); return placementAnswer(r); } }, operatorOrgIds: OPS,
  });
});
after(async () => pool.end());

async function person(grants: { orgId: string; role: string; scope: "self" | "subtree" }[] = [], displayName?: string) {
  const id = `rec2-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid`, ...(displayName ? { displayName } : {}) }));
  // A person with no other grant is a candidate (candidate:self): only candidates are suggested or invited.
  await authz.grantMany(id, grants.length ? grants : [{ orgId: OPS_ORG, role: "candidate", scope: "self" }]);
  return id;
}
async function setup(headcount = 2, period: { periodStart: string; periodEnd: string } | null = null) {
  const orgId = `rec2-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: orgId, name: `Company ${orgId}`, parentOrgId: OPS_ORG }));
  const owner = await person([{ orgId, role: "org-owner", scope: "self" }]);
  const store = await stores.create(owner, orgId, { name: "Avenues", location: null, brandId: null, mallId: null });
  const storeId = (store as { storeId: string }).storeId;
  const created = await requests.create(owner, orgId, { storeId, positionTitle: "Cashier", description: "d", compensationText: "c", positionType: "part_time", headcount, periodStart: period?.periodStart ?? null, periodEnd: period?.periodEnd ?? null, payModel: null, gender: "any", location: null, priority: 0, draft: false });
  const requestId = (created as { requestId: string }).requestId;
  const staff = await person([{ orgId: OPS_ORG, role: "staff", scope: "subtree" }], "Sara Staff");
  const recruiter = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }], "Rami Recruiter");
  const lead = await person([{ orgId: OPS_ORG, role: "admin", scope: "subtree" }]);
  return { orgId, owner, storeId, requestId, staff, recruiter, lead };
}
const request = async (id: string) => (await pool.query<{ status: string; assigned_recruiter_principal_id: string | null; assigned_at: Date | null }>("SELECT status, assigned_recruiter_principal_id, assigned_at FROM recruit_requests WHERE id = $1", [id])).rows[0]!;
const card = async (id: string) => (await pool.query<{ stage: PipelineStage; assignment_id: string | null }>("SELECT stage, assignment_id FROM recruit_pipeline_cards WHERE id = $1", [id])).rows[0]!;
const cardEvents = async (id: string) => (await pool.query<{ from_stage: string | null; to_stage: string; actor_ref: string }>("SELECT from_stage, to_stage, actor_ref FROM recruit_pipeline_events WHERE card_id = $1 ORDER BY at, id", [id])).rows;
async function add(actor: string, requestId: string, who?: string) {
  const r = await pipeline.addCard(actor, requestId, who ?? await person([], `Candidate ${randomUUID().slice(0, 4)}`));
  assert.equal(r.kind, "added", JSON.stringify(r));
  return (r as { cardId: string }).cardId;
}
async function walk(actor: string, cardId: string, stages: PipelineStage[]) {
  for (const to of stages) assert.equal((await pipeline.move(actor, cardId, to)).kind, "moved", `to ${to}`);
}

test("REC2_ASSIGN staff assign an eligible recruiter; reassigning keeps the first time; companies and ineligible people are refused", async () => {
  const s = await setup(), other = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }]), companyRecruiter = await person([{ orgId: s.orgId, role: "recruiter", scope: "subtree" }]);
  assert.deepEqual(await pipeline.assign(s.owner, s.requestId, s.recruiter), { kind: "not_found" }, "a company grantee cannot assign");
  assert.deepEqual(await pipeline.assign(s.staff, s.requestId, companyRecruiter), { kind: "recruiter_ineligible" });
  assert.deepEqual(await pipeline.assign(s.staff, randomUUID(), s.recruiter), { kind: "not_found" });
  assert.deepEqual(await pipeline.assign(s.staff, s.requestId, s.recruiter), { kind: "assigned" });
  const first = (await request(s.requestId)).assigned_at;
  assert.deepEqual(await pipeline.assign(s.lead, s.requestId, other), { kind: "assigned" });
  const after = await request(s.requestId);
  assert.equal(after.assigned_recruiter_principal_id, other);
  assert.equal(after.assigned_at?.toISOString(), first?.toISOString(), "the first assignment time is kept");
  const view = await pipeline.view(s.staff, s.requestId);
  assert.equal(view?.recruiters.some((r) => r.principal_id === s.recruiter && r.name === "Rami Recruiter"), true);
  assert.equal(view?.recruiters.some((r) => r.principal_id === companyRecruiter), false);
  assert.equal(await pipeline.view(s.owner, s.requestId), null, "the pipeline page is for staff");
});

test("REC2_CARD one card per person per request, only on open or filling requests; the first card fills the request with a system activity row", async () => {
  const s = await setup();
  await pipeline.assign(s.staff, s.requestId, s.recruiter);
  const who = await person();
  const cardId = await add(s.recruiter, s.requestId, who);
  assert.deepEqual(await pipeline.addCard(s.recruiter, s.requestId, who), { kind: "duplicate", cardId });
  assert.equal((await request(s.requestId)).status, "filling");
  const activity = (await pool.query("SELECT from_status, to_status, actor_principal_id, actor_ref FROM recruit_request_events WHERE request_id = $1 ORDER BY at, id", [s.requestId])).rows;
  assert.deepEqual(activity.at(-1), { from_status: "open", to_status: "filling", actor_principal_id: null, actor_ref: "0".repeat(64) });
  await add(s.recruiter, s.requestId);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM recruit_request_events WHERE request_id = $1 AND to_status = 'filling'", [s.requestId])).rows[0].n, 1, "a second card leaves filling alone");
  assert.deepEqual(await pipeline.addCard(s.recruiter, s.requestId, "rec2-nobody"), { kind: "not_found" });
  for (const account of [s.owner, s.staff]) assert.deepEqual(await pipeline.addCard(s.recruiter, s.requestId, account), { kind: "not_found" }, "only candidates are suggested; employer and staff accounts are not");
  await requests.transition(s.owner, s.requestId, "closed", "fulfilled");
  assert.deepEqual(await pipeline.addCard(s.recruiter, s.requestId, await person()), { kind: "request_not_open" });
  await assert.rejects(pool.query("INSERT INTO recruit_pipeline_cards(id, request_id, person_principal_id, stage) VALUES($1, $2, $3, 'hired')", [randomUUID(), s.requestId, who]), /check/i);
});

test("REC2_STAGES against Postgres: every ordered pair of stages is allowed exactly as listed, each move writes one event, denied moves change nothing", async () => {
  const s = await setup(100);
  const reach: Record<PipelineStage, PipelineStage[]> = { suggested: [], contacted: ["contacted"], interviewing: ["contacted", "interviewing"], offered: ["contacted", "offered"], placed: ["contacted", "offered", "placed"], withdrawn: ["withdrawn"] };
  const stages = Object.keys(reach) as PipelineStage[];
  for (const from of stages) for (const to of stages) {
    const cardId = await add(s.lead, s.requestId);
    await walk(s.lead, cardId, reach[from]);
    const before = (await cardEvents(cardId)).length;
    const r = await pipeline.move(s.lead, cardId, to);
    const allowed = pipelineTransitionAllowed(from, to);
    assert.equal(r.kind, allowed ? "moved" : "refused", `${from} to ${to}`);
    assert.equal((await card(cardId)).stage, allowed ? to : from);
    assert.equal((await cardEvents(cardId)).length, before + (allowed ? 1 : 0));
  }
  const cardId = await add(s.lead, s.requestId);
  await assert.rejects(pool.query("UPDATE recruit_pipeline_cards SET stage = 'placed' WHERE id = $1", [cardId]), /not allowed/);
  await assert.rejects(pool.query("DELETE FROM recruit_pipeline_cards WHERE id = $1", [cardId]), /never deleted/);
});

test("REC2_AUTHORITY only the assigned recruiter or a lead adds or moves; other staff, companies and strangers get not_found", async () => {
  const s = await setup();
  await pipeline.assign(s.staff, s.requestId, s.recruiter);
  const otherRecruiter = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }]), stranger = await person();
  for (const actor of [s.staff, otherRecruiter, s.owner, stranger]) assert.deepEqual(await pipeline.addCard(actor, s.requestId, await person()), { kind: "not_found" });
  const cardId = await add(s.recruiter, s.requestId);
  for (const actor of [s.staff, otherRecruiter, s.owner, stranger]) assert.deepEqual(await pipeline.move(actor, cardId, "contacted"), { kind: "not_found" });
  assert.equal((await card(cardId)).stage, "suggested");
  assert.equal((await pipeline.move(s.lead, cardId, "contacted")).kind, "moved");
  assert.deepEqual(await pipeline.move(s.recruiter, randomUUID(), "contacted"), { kind: "not_found" });
});

test("REC2_PLACED placing hands the card to the work placement once, records its assignment, and fills the request at headcount", async () => {
  const s = await setup(1, { periodStart: "2026-12-01", periodEnd: "2026-12-31" });
  await pipeline.assign(s.staff, s.requestId, s.recruiter);
  const who = await person();
  const cardId = await add(s.recruiter, s.requestId, who);
  await walk(s.recruiter, cardId, ["contacted", "offered"]);
  placements.length = 0;
  const raced = await Promise.all([pipeline.move(s.recruiter, cardId, "placed"), pipeline.move(s.lead, cardId, "placed")]);
  assert.deepEqual(raced.map((r) => r.kind).sort(), ["moved", "refused"]);
  assert.equal(placements.length, 1, "the loser never calls the placement");
  assert.deepEqual(placements[0], { recruitCardId: cardId, requestId: s.requestId, personId: who, storeId: s.storeId, startDate: "2026-12-01", endDate: "2026-12-31" });
  assert.notEqual((await card(cardId)).assignment_id, null);
  assert.equal((await cardEvents(cardId)).filter((e) => e.to_stage === "placed").length, 1);
  assert.equal((await request(s.requestId)).status, "filled");
  assert.deepEqual(await pipeline.move(s.recruiter, cardId, "placed"), { kind: "refused", stage: "placed" });
});

test("REC2_PLACEMENT_REFUSED a refused placement leaves the card, its events and the request unchanged", async () => {
  const s = await setup(1);
  const cardId = await add(s.lead, s.requestId);
  await walk(s.lead, cardId, ["contacted", "offered"]);
  const before = (await cardEvents(cardId)).length;
  placementAnswer = async () => ({ kind: "refused", code: "overlapping_placement" });
  try {
    assert.deepEqual(await pipeline.move(s.lead, cardId, "placed"), { kind: "placement_refused", code: "overlapping_placement" });
  } finally {
    placementAnswer = async () => ({ kind: "placed", assignmentId: randomUUID(), created: true });
  }
  assert.deepEqual(await card(cardId), { stage: "offered", assignment_id: null });
  assert.equal((await cardEvents(cardId)).length, before);
  assert.equal((await request(s.requestId)).status, "filling");
});

test("REC2_CANCEL_CASCADE closing a request as cancelled withdraws its open cards in the database, leaves placed cards, and writes one system event per card", async () => {
  const s = await setup(5);
  const placed = await add(s.lead, s.requestId), offered = await add(s.lead, s.requestId), suggested = await add(s.lead, s.requestId), withdrawn = await add(s.lead, s.requestId);
  await walk(s.lead, placed, ["contacted", "offered", "placed"]);
  await walk(s.lead, offered, ["contacted", "offered"]);
  await walk(s.lead, withdrawn, ["withdrawn"]);
  assert.equal((await requests.transition(s.owner, s.requestId, "closed", "cancelled")).kind, "transitioned");
  assert.equal((await card(placed)).stage, "placed");
  for (const id of [offered, suggested, withdrawn]) assert.equal((await card(id)).stage, "withdrawn");
  assert.deepEqual((await cardEvents(offered)).at(-1), { from_stage: "offered", to_stage: "withdrawn", actor_ref: "0".repeat(64) });
  assert.deepEqual((await cardEvents(suggested)).at(-1), { from_stage: "suggested", to_stage: "withdrawn", actor_ref: "0".repeat(64) });
  assert.equal((await cardEvents(withdrawn)).length, 2, "an already withdrawn card gets no second event");
  const fulfilled = await setup(5);
  const kept = await add(fulfilled.lead, fulfilled.requestId);
  await requests.transition(fulfilled.owner, fulfilled.requestId, "closed", "fulfilled");
  assert.equal((await card(kept)).stage, "suggested", "only a cancel cascades");
});

test("REC2_VIEW the staff page reads cards, names, recruiter and history in a fixed number of queries", async () => {
  const s = await setup(10);
  await pipeline.assign(s.staff, s.requestId, s.recruiter);
  const named = await person([], "Noor Al-Sabah");
  const cardId = await add(s.recruiter, s.requestId, named);
  for (let i = 0; i < 6; i += 1) await add(s.recruiter, s.requestId);
  await walk(s.recruiter, cardId, ["contacted"]);
  let queries = 0;
  const original = pool.query.bind(pool);
  (pool as unknown as { query: unknown }).query = (...args: Parameters<typeof pool.query>) => { queries += 1; return (original as (...a: unknown[]) => unknown)(...args); };
  let view;
  try { view = await pipeline.view(s.recruiter, s.requestId); } finally { (pool as unknown as { query: unknown }).query = original; }
  assert.equal(queries, 5, "grants, request, cards, events, recruiters");
  assert.deepEqual([view?.canMove, view?.canAssign, view?.recruiters], [true, false, []], "the assigned recruiter works the pipeline but does not reassign it");
  const otherRecruiter = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }]);
  assert.equal(await pipeline.view(otherRecruiter, s.requestId), null, "a recruiter grant alone opens only the pipeline they are assigned to");
  assert.deepEqual(await pipeline.assign(s.recruiter, s.requestId, otherRecruiter), { kind: "not_found" }, "nor can they reassign it");
  queries = 0;
  (pool as unknown as { query: unknown }).query = (...args: Parameters<typeof pool.query>) => { queries += 1; return (original as (...a: unknown[]) => unknown)(...args); };
  try { view = await pipeline.view(s.staff, s.requestId); } finally { (pool as unknown as { query: unknown }).query = original; }
  assert.equal(queries, 5, "grants, request, cards, events, recruiters");
  assert.equal(view?.request.recruiter_name, "Rami Recruiter");
  assert.equal(view?.cards.length, 7);
  assert.equal(view?.cards.find((c) => c.id === cardId)?.person_name, "Noor Al-Sabah");
  assert.deepEqual(view?.events.filter((e) => e.card_id === cardId).map((e) => e.to_stage), ["suggested", "contacted"]);
  assert.equal(view?.canMove, false, "staff who are not the recruiter or a lead see no moves");
});

test("REC2_REVOKE_RACE revoking the assigned recruiter's or a lead's grant, before or during a write, ends their authority over the request", async () => {
  const s = await setup(), noor = await person(), sami = await person();
  assert.equal((await pipeline.assign(s.staff, s.requestId, s.recruiter)).kind, "assigned");
  const cardId = ((await pipeline.addCard(s.recruiter, s.requestId, noor)) as { cardId: string }).cardId;
  assert.deepEqual(await revokeDuring(pool, s.recruiter, () => pipeline.move(s.recruiter, cardId, "contacted")), { kind: "not_found" });
  assert.equal((await card(cardId)).stage, "suggested");
  assert.deepEqual(await pipeline.addCard(s.recruiter, s.requestId, sami), { kind: "not_found" }, "still assigned, but no longer a recruiter: no authority");
  const lead = await person([{ orgId: OPS_ORG, role: "admin", scope: "subtree" }]);
  assert.deepEqual(await revokeDuring(pool, lead, () => pipeline.addCard(lead, s.requestId, sami)), { kind: "not_found" });
  const assigner = await person([{ orgId: OPS_ORG, role: "staff", scope: "subtree" }]), next = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }]);
  assert.deepEqual(await revokeDuring(pool, assigner, () => pipeline.assign(assigner, s.requestId, next)), { kind: "not_found" });
  assert.deepEqual(await revokeDuring(pool, next, () => pipeline.assign(s.staff, s.requestId, next)), { kind: "recruiter_ineligible" }, "a recruiter losing the grant while being assigned is not assigned");
  assert.equal((await request(s.requestId)).assigned_recruiter_principal_id, s.recruiter);
});

test("REC2_NO_HIRE_AFTER_CLOSE a card left at offered on a closed request is not placed; the work placement is never asked", async () => {
  const s = await setup(2);
  await pipeline.assign(s.staff, s.requestId, s.recruiter);
  const cardId = await add(s.recruiter, s.requestId);
  await walk(s.recruiter, cardId, ["contacted", "offered"]);
  assert.equal((await requests.transition(s.owner, s.requestId, "closed", "fulfilled")).kind, "transitioned");
  const asked = placements.length;
  assert.deepEqual(await pipeline.move(s.recruiter, cardId, "placed"), { kind: "refused", stage: "offered" });
  assert.equal(placements.length, asked);
  assert.equal((await card(cardId)).stage, "offered");
  const view = (await pipeline.view(s.staff, s.requestId))!;
  assert.equal(view.request.status, "closed");
  assert.equal((await pipeline.move(s.recruiter, cardId, "withdrawn")).kind, "moved", "withdrawing still clears the card");
});

test("REC2_SUBJECT_GONE a candidate whose grant is revoked, before or during a move, moves no further; withdrawing still works", async () => {
  const s = await setup(5);
  await pipeline.assign(s.staff, s.requestId, s.recruiter);
  const noor = await person(), sami = await person();
  const first = await add(s.recruiter, s.requestId, noor), second = await add(s.recruiter, s.requestId, sami);
  await pool.query("DELETE FROM grants WHERE principal_id = $1", [noor]);
  assert.deepEqual(await pipeline.move(s.recruiter, first, "contacted"), { kind: "subject_unavailable" });
  assert.equal((await card(first)).stage, "suggested");
  assert.equal((await pipeline.move(s.recruiter, first, "withdrawn")).kind, "moved");
  assert.deepEqual(await revokeDuring(pool, sami, () => pipeline.move(s.recruiter, second, "contacted")), { kind: "subject_unavailable" });
  assert.equal((await card(second)).stage, "suggested");
});

test("REC2_PLACEMENT_UNWIRED with no work placement wired the store says so, and the page offers no Placed for a person", async () => {
  const unwired = new PostgresRecruitPipelineStore({ ...pipeline.options, placement: { placeFromRecruit: async () => ({ kind: "refused", code: "work_unavailable" }), available: false } });
  const s = await setup();
  assert.equal((await unwired.view(s.staff, s.requestId))?.canPlacePeople, false);
  assert.equal((await pipeline.view(s.staff, s.requestId))?.canPlacePeople, true);
});
