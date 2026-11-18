import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { organizationStoreReadDecision, organizationStoreWriteDecision } from "@studenthub/organizations";
import { PostgresAuthzStore, PostgresOrganizationStoresStore, PostgresRecruitFulltimersStore, PostgresRecruitInterviewsStore, PostgresRecruitPipelineStore, PostgresRecruitRequestsStore, runMigrations } from "@studenthub/db";
import {
jobCandidateDecision,   evaluationAllowed, fulltimerNameKey, fulltimerStaffDecision, internalNoteDecision, interviewCompanyDecision, interviewOutbox, interviewStageAllowed, interviewTransitionAllowed, pipelineAssignDecision, pipelineAuthority,
  pipelineLeadDecision, pipelineRecruiterEligible, pipelineTransitionAllowed, recruitStaffDecision, requestAcceptsCards, requestCreateDecision, requestReadDecision, requestStatusAfterPipeline, requestTransitionAllowed,
  requestTransitionDecision, type FulltimerFields,
} from "../../recruit/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
const OPS_ORG = `rec9-ops-${randomUUID()}`;
const OPS = [OPS_ORG];
const REF = "c".repeat(64);
const placements: string[] = [];
let pool: pg.Pool, authz: PostgresAuthzStore, stores: PostgresOrganizationStoresStore, requests: PostgresRecruitRequestsStore, pipeline: PostgresRecruitPipelineStore, fulltimers: PostgresRecruitFulltimersStore, interviews: PostgresRecruitInterviewsStore;

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
    placement: { placeFromRecruit: async (_a, r) => { placements.push(r.recruitCardId); return { kind: "placed", assignmentId: randomUUID(), created: true }; } }, operatorOrgIds: OPS,
  });
  fulltimers = new PostgresRecruitFulltimersStore({ pool, staffDecision: (r) => fulltimerStaffDecision(r, OPS), nameKey: fulltimerNameKey, pageSize: 2 });
  interviews = new PostgresRecruitInterviewsStore({
    pool, companyDecision: (r, o, a) => interviewCompanyDecision(r, o, a, OPS), staffDecision: (r) => recruitStaffDecision(r, OPS), leadDecision: (r) => pipelineLeadDecision(r, OPS),
    authority: pipelineAuthority, internalDecision: (r) => internalNoteDecision(r, OPS), stageAllowed: interviewStageAllowed, transitionAllowed: interviewTransitionAllowed, evaluationAllowed, outbox: interviewOutbox,
  });
});
after(async () => pool.end());

async function person(grants: { orgId: string; role: string; scope: "self" | "subtree" }[] = []) {
  const id = `rec9-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  // A person with no other grant is a candidate (candidate:self): only candidates are suggested or invited.
  await authz.grantMany(id, grants.length ? grants : [{ orgId: OPS_ORG, role: "candidate", scope: "self" }]);
  return id;
}
async function catalogue(type: "area" | "country") {
  const id = randomUUID();
  await pool.query("INSERT INTO catalogue_items(id, catalogue_type, name, normalized_name, code, status, created_by_ref, updated_by_ref, created_at, updated_at) VALUES($1, $2, $3, $3, NULL, 'active', $4, $4, now(), now())", [id, type, `${type} ${id.slice(0, 8)}`, REF]);
  return id;
}
const fields = (o: Partial<FulltimerFields> = {}): FulltimerFields => ({
  name: `Fahad ${randomUUID().slice(0, 8)}`, phone: null, email: null, nationalityId: null, countryId: null, areaId: null, universityId: null, latitude: null, longitude: null, gender: "male", birthDate: "1995-04-01",
  employed: false, drivingLicence: true, currentSalary: null, expectedSalary: "600", currencyCode: "KWD", tags: [], skills: ["Arabic"], experience: [], cvReference: null, ...o,
});

test("REC9_RECORDS staff and recruiters keep full-timers; a live duplicate name or phone is refused and named; archive frees them", async () => {
  const staff = await person([{ orgId: OPS_ORG, role: "staff", scope: "subtree" }]), recruiter = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }]), stranger = await person();
  const area = await catalogue("area"), country = await catalogue("country"), tag = `t${randomUUID().slice(0, 8)}`, phone = `+965${String(Date.now()).slice(-8)}`;
  assert.deepEqual(await fulltimers.create(stranger, fields()), { kind: "not_found" });
  assert.deepEqual(await fulltimers.create(staff, fields({ areaId: country })), { kind: "reference_invalid", field: "areaId" });
  const first = await fulltimers.create(staff, fields({ name: `Fahad Al-Ali ${tag}`, phone, areaId: area, nationalityId: country, tags: [tag] }));
  assert.equal(first.kind, "saved");
  const id = (first as { fulltimerId: string }).fulltimerId;
  assert.deepEqual(await fulltimers.create(recruiter, fields({ name: `  fahad   al-ali ${tag.toUpperCase()}` })), { kind: "duplicate", field: "name", fulltimerId: id });
  assert.deepEqual(await fulltimers.create(recruiter, fields({ phone })), { kind: "duplicate", field: "phone", fulltimerId: id });
  const second = ((await fulltimers.create(recruiter, fields({ tags: [tag] }))) as { fulltimerId: string }).fulltimerId;
  assert.deepEqual(await fulltimers.update(staff, second, fields({ name: `Fahad Al-Ali ${tag}`, tags: [tag] })), { kind: "duplicate", field: "name", fulltimerId: id });
  const got = (await fulltimers.get(recruiter, id))!;
  assert.deepEqual([got.fulltimer.area_name?.startsWith("area"), got.fulltimer.nationality_name?.startsWith("country"), got.fulltimer.phone, got.cards], [true, true, phone, []]);
  assert.equal(await fulltimers.get(stranger, id), null);
  const page1 = (await fulltimers.list(staff, { q: null, currency: "KWD", tag, archived: false, page: 1 }))!;
  assert.deepEqual([page1.total, page1.rows.length], [2, 2]);
  assert.equal((await fulltimers.list(staff, { q: null, currency: "USD", tag, archived: false, page: 1 }))!.total, 0, "the currency filter, as legacy");
  assert.equal(await fulltimers.list(stranger, { q: null, currency: "KWD", tag: null, archived: false, page: 1 }), null);
  assert.deepEqual(await fulltimers.archive(staff, id, true), { kind: "saved", fulltimerId: id });
  assert.equal((await fulltimers.create(staff, fields({ name: `Fahad Al-Ali ${tag}`, phone }))).kind, "saved", "an archived record frees its name and phone");
  assert.equal((await fulltimers.archive(staff, id, false)).kind, "duplicate", "restoring is refused while another live record holds the name");
  assert.deepEqual((await fulltimers.list(staff, { q: null, currency: "KWD", tag, archived: true, page: 1 }))!.rows.map((r) => r.id), [id]);
  await assert.rejects(pool.query("DELETE FROM recruit_fulltimers WHERE id = $1", [id]), /archived, never deleted/);
});

test("REC9_PIPELINE a full-timer joins a request's pipeline once; placing records the hire without a work assignment; nobody is notified", async () => {
  const orgId = `rec9-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: orgId, name: "Sultan Co", parentOrgId: OPS_ORG }));
  const owner = await person([{ orgId, role: "org-owner", scope: "self" }]);
  const storeId = ((await stores.create(owner, orgId, { name: "Avenues", location: null, brandId: null, mallId: null })) as { storeId: string }).storeId;
  const requestId = ((await requests.create(owner, orgId, { storeId, positionTitle: "Manager", description: "d", compensationText: "800 KWD", positionType: "full_time", headcount: 1, periodStart: null, periodEnd: null, payModel: "monthly_salary", gender: "any", location: null, priority: 0, draft: false })) as { requestId: string }).requestId;
  const staff = await person([{ orgId: OPS_ORG, role: "staff", scope: "subtree" }]), lead = await person([{ orgId: OPS_ORG, role: "admin", scope: "subtree" }]), recruiter = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }]);
  await pipeline.assign(lead, requestId, recruiter);
  const ft = ((await fulltimers.create(staff, fields())) as { fulltimerId: string }).fulltimerId;
  const archived = ((await fulltimers.create(staff, fields())) as { fulltimerId: string }).fulltimerId;
  await fulltimers.archive(staff, archived, true);
  assert.deepEqual(await pipeline.addFulltimerCard(recruiter, requestId, archived), { kind: "not_found" }, "an archived record is not suggested");
  assert.deepEqual(await pipeline.addFulltimerCard(owner, requestId, ft), { kind: "not_found" });
  const added = await pipeline.addFulltimerCard(recruiter, requestId, ft);
  assert.equal(added.kind, "added");
  const cardId = (added as { cardId: string }).cardId;
  assert.deepEqual(await pipeline.addFulltimerCard(recruiter, requestId, ft), { kind: "duplicate", cardId });
  for (const to of ["contacted", "interviewing"] as const) assert.equal((await pipeline.move(recruiter, cardId, to)).kind, "moved");
  const interview = await interviews.schedule(owner, requestId, { cardId, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), durationMinutes: 30, mode: "in_person", location: null });
  assert.equal(interview.kind, "scheduled", "the company interviews a full-timer like anyone else");
  assert.equal((await pool.query("SELECT 1 FROM recruit_outbox WHERE subject_id = $1", [(interview as { interviewId: string }).interviewId])).rowCount, 0, "a full-timer has no account to notify");
  assert.equal((await interviews.forRequest(owner, requestId))!.interviews[0]!.person_name?.startsWith("Fahad"), true);
  assert.equal((await pipeline.move(recruiter, cardId, "offered")).kind, "moved");
  assert.deepEqual(await pipeline.move(recruiter, cardId, "placed"), { kind: "moved", stage: "placed" });
  assert.deepEqual(placements.includes(cardId), false, "the work lane is never asked to pay a full-timer");
  const card = (await pool.query<{ assignment_id: string | null }>("SELECT assignment_id FROM recruit_pipeline_cards WHERE id = $1", [cardId])).rows[0]!;
  assert.equal(card.assignment_id, null);
  const view = (await pipeline.view(lead, requestId))!;
  assert.deepEqual(view.cards.map((c) => [c.person_principal_id, c.fulltimer_id, c.stage]), [[null, ft, "placed"]]);
  assert.equal((await requests.get(owner, requestId))!.people!.map((p) => p.person_principal_id)[0], null, "the company sees the full-timer by name only");
  assert.deepEqual((await fulltimers.get(staff, ft))!.cards.map((c) => [c.request_id, c.stage]), [[requestId, "placed"]]);
  await assert.rejects(pool.query("INSERT INTO recruit_pipeline_cards(id, request_id, person_principal_id, fulltimer_id, stage) VALUES($1, $2, $3, $4, 'suggested')", [randomUUID(), requestId, owner, ft]), /one_subject/);
  await assert.rejects(pool.query("UPDATE recruit_pipeline_cards SET fulltimer_id = $2 WHERE id = $1", [cardId, archived]), /cannot move/);
});

test("REC9_PHONE_RACE simultaneous saves with different names and one phone: exactly one is saved, the other is told the phone is taken", async () => {
  // Different staff accounts, so nothing but the duplicate check serialises the saves.
  const staff = await Promise.all(Array.from({ length: 6 }, () => person([{ orgId: OPS_ORG, role: "staff", scope: "subtree" }])));
  const phone = `+9656${String(Date.now()).slice(-7)}`;
  const results = await Promise.all(staff.map((who) => fulltimers.create(who, fields({ phone }))));
  const saved = results.filter((r) => r.kind === "saved");
  assert.equal(saved.length, 1);
  const winner = (saved[0] as { fulltimerId: string }).fulltimerId;
  for (const r of results) if (r.kind !== "saved") assert.deepEqual(r, { kind: "duplicate", field: "phone", fulltimerId: winner });
});
