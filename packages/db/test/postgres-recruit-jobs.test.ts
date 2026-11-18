import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { organizationStoreReadDecision, organizationStoreWriteDecision } from "@studenthub/organizations";
import { PostgresAuthzStore, PostgresOrganizationStoresStore, PostgresRecruitJobsStore, PostgresRecruitRequestsStore, runMigrations } from "@studenthub/db";
import {
  applicationOutbox, applicationTransitionAllowed, jobAcceptsApplications, jobCandidateDecision, jobStaffDecision, recruitStaffDecision, requestCreateDecision, requestReadDecision, requestTransitionAllowed, requestTransitionDecision, type JobFields,
} from "../../recruit/src/index.js";
import { PostgresAccessPausesStore } from "@studenthub/db";
import { revokeDuring } from "./recruit-races.js";

const URL = process.env.DATABASE_URL ?? "";
const OPS_ORG = `rec7-ops-${randomUUID()}`;
const OPS = [OPS_ORG];
const REF = "c".repeat(64);
let pool: pg.Pool, authz: PostgresAuthzStore, stores: PostgresOrganizationStoresStore, requests: PostgresRecruitRequestsStore, jobs: PostgresRecruitJobsStore;

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
  jobs = new PostgresRecruitJobsStore({ pool, staffDecision: (r) => jobStaffDecision(r, OPS), candidateDecision: jobCandidateDecision, acceptsApplications: jobAcceptsApplications, transitionAllowed: applicationTransitionAllowed, outbox: applicationOutbox, pageSize: 2 });
});
after(async () => pool.end());

async function person(grants: { orgId: string; role: string; scope: "self" | "subtree" }[] = [], displayName?: string) {
  const id = `rec7-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid`, ...(displayName ? { displayName } : {}) }));
  if (grants.length) await authz.grantMany(id, grants);
  return id;
}
const candidate = (displayName?: string) => person([{ orgId: OPS_ORG, role: "candidate", scope: "self" }], displayName);
async function catalogue(type: "area" | "country", name: string) {
  const id = randomUUID();
  await pool.query("INSERT INTO catalogue_items(id, catalogue_type, name, normalized_name, code, status, created_by_ref, updated_by_ref, created_at, updated_at) VALUES($1, $2, $3, $3, NULL, 'active', $4, $4, now(), now())", [id, type, `${name} ${id.slice(0, 8)}`, REF]);
  return id;
}
async function setup() {
  const orgId = `rec7-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: orgId, name: "Sultan Co", parentOrgId: OPS_ORG }));
  const owner = await person([{ orgId, role: "org-owner", scope: "self" }]);
  const storeId = ((await stores.create(owner, orgId, { name: "Avenues", location: null, brandId: null, mallId: null })) as { storeId: string }).storeId;
  const requestId = ((await requests.create(owner, orgId, { storeId, positionTitle: "Cashier", description: "d", compensationText: "3 KWD an hour", positionType: "part_time", headcount: 2, periodStart: "2026-12-01", periodEnd: "2026-12-31", payModel: "hourly", gender: "any", location: null, priority: 0, draft: false })) as { requestId: string }).requestId;
  const staff = await person([{ orgId: OPS_ORG, role: "staff", scope: "subtree" }]);
  const recruiter = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }]);
  return { owner, requestId, staff, recruiter };
}
const unique = `rec7${randomUUID().slice(0, 8)}`;
const job = (requestId: string, o: Partial<JobFields> = {}): JobFields => ({
  requestId, areaId: null, position: `Cashier ${unique}`, positionAr: null, description: null, descriptionAr: null, hoursPerDay: 6, daysPerWeek: 5, compensationType: "hourly", compensationAmount: "3 KWD",
  compensationDescription: null, compensationDescriptionAr: null, minAge: 18, maxAge: 30, gender: "female", availableFrom: null, availableTo: null, status: "active", skills: ["Arabic"], ...o,
});

test("REC7_PUBLISH staff publish and edit jobs; nobody else does; areas must be areas", async () => {
  const s = await setup(), area = await catalogue("area", "Hawalli"), country = await catalogue("country", "Kuwait");
  for (const who of [s.owner, s.recruiter]) assert.deepEqual(await jobs.create(who, job(s.requestId)), { kind: "not_found" });
  assert.deepEqual(await jobs.create(s.staff, job(randomUUID())), { kind: "not_found" });
  assert.deepEqual(await jobs.create(s.staff, job(s.requestId, { areaId: country })), { kind: "area_invalid" });
  const created = await jobs.create(s.staff, job(s.requestId, { areaId: area, status: "draft" }));
  assert.equal(created.kind, "saved");
  const id = (created as { jobId: string }).jobId;
  assert.deepEqual(await jobs.update(s.staff, id, job(s.requestId, { areaId: area, position: `Senior cashier ${unique}`, skills: ["Arabic", "English"] })), { kind: "saved", jobId: id });
  assert.deepEqual(await jobs.update(s.owner, id, job(s.requestId)), { kind: "not_found" });
  const got = (await jobs.get(s.staff, id))!;
  assert.deepEqual([got.staff, got.job.position, got.job.area_name?.startsWith("Hawalli"), got.job.skills, got.job.status, got.job.org_name], [true, `Senior cashier ${unique}`, true, ["Arabic", "English"], "active", "Sultan Co"]);
  assert.deepEqual((await jobs.staffList(s.staff, { status: null, requestId: s.requestId }))!.map((j) => j.id), [id]);
  assert.equal(await jobs.staffList(s.owner, { status: null, requestId: null }), null);
  await assert.rejects(pool.query("DELETE FROM recruit_jobs WHERE id = $1", [id]), /close them/);
});

test("REC7_APPLY a person applies once to an active job; drafts are invisible; a closed job refuses; the board pages and searches", async () => {
  const s = await setup(), noor = await candidate("Noor"), tag = `apply${randomUUID().slice(0, 8)}`, mk = (o: Partial<JobFields> = {}) => job(s.requestId, { position: `Cashier ${tag}`, ...o });
  const active = ((await jobs.create(s.staff, mk())) as { jobId: string }).jobId;
  const draft = ((await jobs.create(s.staff, mk({ status: "draft" }))) as { jobId: string }).jobId;
  const closed = ((await jobs.create(s.staff, mk({ status: "closed" }))) as { jobId: string }).jobId;
  const other = ((await jobs.create(s.staff, mk({ position: `Packer ${tag}` }))) as { jobId: string }).jobId;
  assert.equal(await jobs.get(noor, draft), null, "a draft is not shown");
  assert.equal(await jobs.get(noor, closed), null, "a closed job is not shown to someone who never applied");
  assert.deepEqual(await jobs.apply(noor, draft, null), { kind: "not_found" });
  assert.deepEqual(await jobs.apply(noor, closed, null), { kind: "job_closed" });
  const applied = await jobs.apply(noor, active, "I can start Monday");
  assert.equal(applied.kind, "applied");
  const appId = (applied as { applicationId: string }).applicationId;
  assert.deepEqual(await jobs.apply(noor, active, "again"), { kind: "duplicate", applicationId: appId });
  const board = (await jobs.board(noor, { q: tag, applied: false, page: 1 }))!;
  assert.deepEqual([board.total, board.jobs.map((j) => j.id)], [1, [other]], "applied, draft and closed jobs leave the board");
  assert.deepEqual((await jobs.board(noor, { q: `Packer ${tag}`, applied: false, page: 1 }))!.jobs.map((j) => j.id), [other]);
  assert.equal((await jobs.board(noor, { q: "%", applied: false, page: 1 }))!.total, 0, "wildcards are literal");
  const mine = (await jobs.board(noor, { q: null, applied: true, page: 1 }))!;
  assert.deepEqual(mine.jobs.map((j) => [j.id, j.application_status]), [[active, "interested"]]);
  await jobs.update(s.staff, active, mk({ status: "closed" }));
  assert.equal((await jobs.get(noor, active))!.job.status, "closed", "an applicant still sees the job they applied to");
  const other2 = await candidate();
  for (let i = 0; i < 3; i++) await jobs.create(s.staff, job(s.requestId, { position: `Page ${tag} ${i}` }));
  const page1 = (await jobs.board(other2, { q: `Page ${tag}`, applied: false, page: 1 }))!, page2 = (await jobs.board(other2, { q: `Page ${tag}`, applied: false, page: 2 }))!;
  assert.deepEqual([page1.total, page1.jobs.length, page2.jobs.length], [3, 2, 1]);
  await assert.rejects(pool.query("UPDATE recruit_job_applications SET note = 'changed' WHERE id = $1", [appId]), /keeps/);
});

test("REC7_CANDIDATE only candidates browse and apply (candidate:self); employer, staff and grantless accounts get nothing", async () => {
  const s = await setup(), nobody = await person();
  const id = ((await jobs.create(s.staff, job(s.requestId))) as { jobId: string }).jobId;
  for (const who of [s.owner, s.staff, s.recruiter, nobody]) {
    assert.equal(await jobs.board(who, { q: null, applied: false, page: 1 }), null, who);
    assert.deepEqual(await jobs.apply(who, id, null), { kind: "not_found" }, who);
  }
  for (const who of [s.owner, s.recruiter, nobody]) assert.equal(await jobs.get(who, id), null, who);
  assert.equal((await jobs.get(s.staff, id))!.staff, true, "staff still manage the job");
  assert.equal((await pool.query("SELECT 1 FROM recruit_job_applications WHERE job_id = $1", [id])).rowCount, 0);
});

test("REC7_DECIDE staff shortlist or reject once; the person hears; nobody else decides", async () => {
  const s = await setup(), noor = await candidate("Noor");
  const id = ((await jobs.create(s.staff, job(s.requestId))) as { jobId: string }).jobId;
  const app = ((await jobs.apply(noor, id, null)) as { applicationId: string }).applicationId;
  assert.deepEqual(await jobs.decide(s.recruiter, app, "shortlisted"), { kind: "not_found" });
  assert.equal(await jobs.applications(s.owner, id), null);
  assert.deepEqual(await jobs.decide(s.staff, app, "shortlisted"), { kind: "decided", status: "shortlisted" });
  assert.deepEqual(await jobs.decide(s.staff, app, "shortlisted"), { kind: "refused", status: "shortlisted" });
  assert.deepEqual(await jobs.decide(s.staff, app, "rejected"), { kind: "decided", status: "rejected" });
  assert.deepEqual(await jobs.decide(s.staff, app, "shortlisted"), { kind: "refused", status: "rejected" });
  assert.deepEqual((await jobs.applications(s.staff, id))!.map((a) => [a.person_name, a.status]), [["Noor", "rejected"]]);
  const outbox = (await pool.query<{ kind: string; recipient_principal_id: string }>("SELECT kind, recipient_principal_id FROM recruit_outbox WHERE subject_id = $1 ORDER BY id", [app])).rows.map((r) => [r.kind, r.recipient_principal_id]);
  assert.deepEqual(outbox, [["application.shortlisted", noor], ["application.rejected", noor]]);
  assert.deepEqual(await jobs.decide(s.staff, randomUUID(), "rejected"), { kind: "not_found" });
});

test("REC7_REVOKE_RACE staff losing the grant while publishing, editing or deciding, or a candidate losing it while applying, is refused", async () => {
  const s = await setup();
  const publisher = await person([{ orgId: OPS_ORG, role: "staff", scope: "subtree" }]);
  assert.deepEqual(await revokeDuring(pool, publisher, () => jobs.create(publisher, job(s.requestId))), { kind: "not_found" });
  const jobId = ((await jobs.create(s.staff, job(s.requestId))) as { jobId: string }).jobId;
  const editor = await person([{ orgId: OPS_ORG, role: "staff", scope: "subtree" }]);
  assert.deepEqual(await revokeDuring(pool, editor, () => jobs.update(editor, jobId, job(s.requestId, { position: "late" }))), { kind: "not_found" });
  const noor = await candidate(), sami = await candidate();
  assert.deepEqual(await revokeDuring(pool, sami, () => jobs.apply(sami, jobId, null)), { kind: "not_found" });
  const applicationId = ((await jobs.apply(noor, jobId, null)) as { applicationId: string }).applicationId;
  const decider = await person([{ orgId: OPS_ORG, role: "staff", scope: "subtree" }]);
  assert.deepEqual(await revokeDuring(pool, decider, () => jobs.decide(decider, applicationId, "shortlisted")), { kind: "not_found" });
  assert.deepEqual((await jobs.applications(s.staff, jobId))!.map((a) => [a.person_principal_id, a.status]), [[noor, "interested"]]);
});

test("REC7_RELINK a job moves to another request only until someone applies; other edits stay open", async () => {
  const s = await setup(), t = await setup();
  const id = ((await jobs.create(s.staff, job(s.requestId))) as { jobId: string }).jobId;
  assert.deepEqual(await jobs.update(s.staff, id, job(t.requestId)), { kind: "saved", jobId: id }, "no applications yet: relinking is a correction");
  assert.deepEqual(await jobs.update(s.staff, id, job(s.requestId)), { kind: "saved", jobId: id });
  assert.equal((await jobs.apply(await candidate(), id, null)).kind, "applied");
  assert.deepEqual(await jobs.update(s.staff, id, job(t.requestId)), { kind: "request_locked" }, "applications keep the company they applied to");
  assert.deepEqual(await jobs.update(s.staff, id, job(s.requestId, { position: `Head cashier ${unique}` })), { kind: "saved", jobId: id });
  assert.equal((await pool.query<{ request_id: string }>("SELECT request_id FROM recruit_jobs WHERE id = $1", [id])).rows[0]!.request_id, s.requestId);
});
