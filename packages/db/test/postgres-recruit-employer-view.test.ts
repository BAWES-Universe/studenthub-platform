import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { organizationStoreReadDecision, organizationStoreWriteDecision } from "@studenthub/organizations";
import { PostgresAuthzStore, PostgresOrganizationStoresStore, PostgresRecruitInvitationsStore, PostgresRecruitPipelineStore, PostgresRecruitRequestsStore, runMigrations } from "@studenthub/db";
import {
  acceptCardEffect, invitationOutbox, invitationTransitionAllowed, pipelineAssignDecision, pipelineAuthority, pipelineLeadDecision, pipelineRecruiterEligible, pipelineTransitionAllowed,
  recruitNotesDecision, recruitStaffDecision, requestAcceptsCards, requestCreateDecision, requestReadDecision, requestStatusAfterPipeline, requestTransitionAllowed, requestTransitionDecision,
} from "../../recruit/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
const OPS_ORG = `rec5-ops-${randomUUID()}`;
const OPS = [OPS_ORG];
let pool: pg.Pool, authz: PostgresAuthzStore, stores: PostgresOrganizationStoresStore, requests: PostgresRecruitRequestsStore, pipeline: PostgresRecruitPipelineStore, invitations: PostgresRecruitInvitationsStore;

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
  invitations = new PostgresRecruitInvitationsStore({
    pool, leadDecision: (r) => pipelineLeadDecision(r, OPS), staffDecision: (r) => recruitNotesDecision(r, OPS), authority: pipelineAuthority, acceptsCards: requestAcceptsCards,
    transitionAllowed: invitationTransitionAllowed, acceptCardEffect, requestStatusAfter: requestStatusAfterPipeline, outbox: invitationOutbox,
  });
});
after(async () => pool.end());

async function person(grants: { orgId: string; role: string; scope: "self" | "subtree" }[] = [], displayName?: string) {
  const id = `rec5-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid`, ...(displayName ? { displayName } : {}) }));
  if (grants.length) await authz.grantMany(id, grants);
  return id;
}
async function setup() {
  const orgId = `rec5-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: orgId, name: "Sultan Co", parentOrgId: OPS_ORG }));
  const owner = await person([{ orgId, role: "org-owner", scope: "self" }]);
  const storeId = ((await stores.create(owner, orgId, { name: "Avenues", location: null, brandId: null, mallId: null })) as { storeId: string }).storeId;
  const requestId = ((await requests.create(owner, orgId, { storeId, positionTitle: "Cashier", description: "d", compensationText: "3 KWD an hour", positionType: "part_time", headcount: 2, periodStart: "2026-12-01", periodEnd: "2026-12-31", payModel: "hourly", gender: "any", location: null, priority: 0, draft: false })) as { requestId: string }).requestId;
  const staff = await person([{ orgId: OPS_ORG, role: "staff", scope: "subtree" }]);
  const recruiter = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }], "Rami Recruiter");
  const other = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }]);
  await pipeline.assign(staff, requestId, recruiter);
  return { orgId, owner, requestId, staff, recruiter, other };
}
const REF = "c".repeat(64);
async function catalogue(type: string, name: string) {
  const id = randomUUID();
  await pool.query("INSERT INTO catalogue_items(id, catalogue_type, name, normalized_name, status, created_by_ref, updated_by_ref, created_at, updated_at) VALUES($1, $2, $3, $3, 'active', $4, $4, now(), now())", [id, type, name, REF]);
  return id;
}
async function profile(id: string) {
  const uni = await catalogue("university", `KU ${randomUUID().slice(0, 4)}`);
  await pool.query(`INSERT INTO person_profiles(principal_id, display_name, display_name_written_at, objective, objective_written_at, gender, gender_written_at, birth_date, birth_date_written_at, job_search_status, job_search_status_written_at)
    VALUES($1, 'Noor Sabah', now(), 'Retail work', now(), 'female', now(), '2000-01-01', now(), 'active', now())`, [id]);
  for (const [kind, fields] of [["education", { educationType: "standard", universityId: uni, currentlyStudying: true }], ["skill", { name: "Arabic" }], ["experience", { title: "Cashier", employer: "Co", startYear: 2020 }], ["link", { title: "Site", url: "https://x.invalid" }]] as const) {
    await pool.query("INSERT INTO candidate_profile_records(id, owner_principal_id, kind, status, fields, created_at, updated_at) VALUES($1, $2, $3, 'active', $4, now(), now())", [randomUUID(), id, kind, fields]);
  }
}

test("REC5_SIGHT a company reads people on its own requests only; links decide; staff read any; records come with names", async () => {
  const s = await setup(), noor = await person(), stranger = await person();
  await profile(noor);
  assert.equal(await requests.person(s.owner, s.requestId, noor), null, "no card and no invitation: nothing");
  const cardId = ((await pipeline.addCard(s.recruiter, s.requestId, noor)) as { cardId: string }).cardId;
  const seen = (await requests.person(s.owner, s.requestId, noor))!;
  assert.equal(seen.person.name, "Noor Sabah");
  assert.equal(seen.person.birth_date, "2000-01-01");
  assert.deepEqual(seen.link, { stage: "suggested", invitation_status: null });
  assert.deepEqual(seen.records.map((r) => r.kind).sort(), ["education", "experience", "skill"], "links are not part of the employer view");
  assert.equal(seen.records.find((r) => r.kind === "education")!.university?.startsWith("KU"), true);
  assert.equal(seen.staff, false);
  const other = await setup();
  assert.equal(await requests.person(other.owner, s.requestId, noor), null, "another company's owner sees nothing");
  assert.equal(await requests.person(s.owner, s.requestId, stranger), null);
  assert.equal((await requests.person(s.staff, s.requestId, noor))!.staff, true);
  await pipeline.move(s.recruiter, cardId, "withdrawn");
  assert.deepEqual((await requests.person(s.owner, s.requestId, noor))!.link, { stage: "withdrawn", invitation_status: null }, "the page decides that a withdrawn card gives no sight");
});
