import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { organizationStoreReadDecision, organizationStoreWriteDecision } from "@studenthub/organizations";
import { PostgresAuthzStore, PostgresOrganizationStoresStore, PostgresRecruitRequestsStore, runMigrations } from "@studenthub/db";
import { recruitStaffDecision, requestCreateDecision, requestReadDecision, requestTransitionAllowed, requestTransitionDecision, type RequestStatus } from "../../recruit/src/index.js";
import { revokeDuring } from "./recruit-races.js";

const URL = process.env.DATABASE_URL ?? "";
const OPS = ["root"];
let pool: pg.Pool, authz: PostgresAuthzStore, stores: PostgresOrganizationStoresStore, requests: PostgresRecruitRequestsStore;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: "root", name: "StudentHub" }));
  stores = new PostgresOrganizationStoresStore({ pool, writeDecision: organizationStoreWriteDecision, readDecision: organizationStoreReadDecision });
  requests = new PostgresRecruitRequestsStore({
    pool,
    createDecision: (r, o, a) => requestCreateDecision(r, o, a, OPS),
    readDecision: (r, o, a) => requestReadDecision(r, o, a, OPS),
    transitionDecision: (r, o, a) => requestTransitionDecision(r, o, a, OPS),
    staffDecision: (r) => recruitStaffDecision(r, OPS),
    transitionAllowed: requestTransitionAllowed,
    managedStores: async () => [],
  });
});
after(async () => pool.end());

async function organization(parentOrgId = "root") {
  const id = `rec1-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id, name: `Company ${id}`, parentOrgId }));
  return id;
}
async function principal(orgId: string, role = "org-owner", scope: "self" | "subtree" = "self", displayName?: string) {
  const id = `rec1-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid`, ...(displayName ? { displayName } : {}) }));
  await authz.grantMany(id, [{ orgId, role, scope }]);
  return id;
}
async function store(orgId: string) {
  const owner = await principal(orgId);
  const created = await stores.create(owner, orgId, { name: `Store ${randomUUID().slice(0, 8)}`, location: null, brandId: null, mallId: null });
  assert.equal(created.kind, "created");
  return (created as { storeId: string }).storeId;
}
const fields = (storeId: string, over: Record<string, unknown> = {}) => ({
  storeId, positionTitle: "Cashier", description: "Front till", compensationText: "3 KWD an hour", positionType: "part_time" as const, headcount: 2,
  periodStart: null, periodEnd: null, payModel: null, gender: "any" as const, location: null, priority: 0, draft: false, ...over,
});
async function create(orgId: string, actor: string, storeId: string, over: Record<string, unknown> = {}) {
  const r = await requests.create(actor, orgId, fields(storeId, over));
  assert.equal(r.kind, "created");
  return (r as { requestId: string }).requestId;
}
const statusOf = async (id: string) => (await pool.query<{ status: RequestStatus; close_reason: string | null; assigned_recruiter_principal_id: string | null }>("SELECT status, close_reason, assigned_recruiter_principal_id FROM recruit_requests WHERE id = $1", [id])).rows[0]!;
const eventCount = async (id: string) => Number((await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM recruit_request_events WHERE request_id = $1", [id])).rows[0]!.n);

test("REC1_CREATE owners, recruiters, and staff through subtree create for the company's own active store; anything else is not_found", async () => {
  const orgId = await organization(), other = await organization(), storeId = await store(orgId), otherStore = await store(other);
  const owner = await principal(orgId), recruiter = await principal(orgId, "recruiter"), staff = await principal("root", "staff", "subtree"), finance = await principal(orgId, "finance");
  const full = await create(orgId, owner, storeId, { periodStart: "2026-12-01", periodEnd: "2026-12-31", payModel: "monthly_salary", gender: "female", location: "Avenues", priority: 4 });
  const detail = await requests.get(owner, full);
  assert.equal(detail?.request.status, "open");
  assert.deepEqual([detail?.request.period_start, detail?.request.period_end, detail?.request.pay_model, detail?.request.gender, detail?.request.priority], ["2026-12-01", "2026-12-31", "monthly_salary", "female", 4]);
  assert.equal((await requests.get(owner, await create(orgId, recruiter, storeId, { draft: true })))?.request.status, "draft");
  await create(orgId, staff, storeId);
  assert.deepEqual(await requests.create(owner, orgId, fields(otherStore)), { kind: "not_found" }, "another company's store");
  assert.deepEqual(await requests.create(finance, orgId, fields(storeId)), { kind: "not_found" }, "finance has no recruit grant");
  assert.deepEqual(await requests.create(staff, "root", fields(storeId)), { kind: "not_found" }, "operator organization");
  assert.deepEqual(await requests.create(owner, orgId, fields(randomUUID())), { kind: "not_found" }, "unknown store");
  const removed = await store(orgId);
  assert.equal((await stores.remove(owner, orgId, removed)).kind, "removed");
  assert.deepEqual(await requests.create(owner, orgId, fields(removed)), { kind: "not_found" }, "deleted store");
  await assert.rejects(pool.query("UPDATE recruit_requests SET store_id = $2 WHERE id = $1", [full, otherStore]), /cannot move|must belong/);
});

test("REC1_TRANSITIONS against Postgres: every ordered pair is allowed exactly as listed, denied pairs change nothing", async () => {
  const orgId = await organization(), storeId = await store(orgId), owner = await principal(orgId);
  const paths: Record<RequestStatus, RequestStatus[]> = { draft: [], open: ["open"], filling: ["open", "filling"], filled: ["open", "filling", "filled"], closed: ["open", "closed"] };
  const statuses: RequestStatus[] = ["draft", "open", "filling", "filled", "closed"];
  for (const from of statuses) for (const to of statuses) {
    const id = await create(orgId, owner, storeId, { draft: true });
    let reached: RequestStatus = "draft";
    for (const step of paths[from]) {
      const r = await requests.transition(owner, id, step, step === "closed" ? "fulfilled" : null);
      assert.equal(r.kind, "transitioned", `${reached} to ${step}`);
      reached = step;
    }
    const before = await eventCount(id);
    const r = await requests.transition(owner, id, to, to === "closed" ? "cancelled" : null);
    const allowed = requestTransitionAllowed(from, to);
    assert.equal(r.kind, allowed ? "transitioned" : "refused", `${from} to ${to}`);
    assert.equal((await statusOf(id)).status, allowed ? to : from);
    assert.equal(await eventCount(id), before + (allowed ? 1 : 0));
  }
  const closed = await create(orgId, owner, storeId);
  await requests.transition(owner, closed, "closed", "fulfilled");
  await assert.rejects(pool.query("UPDATE recruit_requests SET status = 'open', close_reason = NULL WHERE id = $1", [closed]), /not allowed|read-only/);
  await assert.rejects(pool.query("DELETE FROM recruit_requests WHERE id = $1", [closed]), /never deleted/);
});

test("REC1_ACTIVITY a status change and its activity row commit together; a failed activity insert rolls the change back", async () => {
  const orgId = await organization(), storeId = await store(orgId), owner = await principal(orgId, "org-owner", "self", "Dana Owner");
  const id = await create(orgId, owner, storeId);
  await requests.transition(owner, id, "filling", null);
  const detail = await requests.get(owner, id);
  assert.deepEqual(detail?.events.map((e) => [e.from_status, e.to_status, e.close_reason, e.actor_name]), [[null, "open", null, "Dana Owner"], ["open", "filling", null, "Dana Owner"]]);
  const fn = `rec1_fail_${randomUUID().replace(/-/g, "")}`;
  await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id = '${id}' THEN RAISE EXCEPTION 'activity down'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON recruit_request_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    await assert.rejects(requests.transition(owner, id, "filled", null), /activity down/);
  } finally {
    await pool.query(`DROP TRIGGER ${fn} ON recruit_request_events`);
    await pool.query(`DROP FUNCTION ${fn}()`);
  }
  assert.equal((await statusOf(id)).status, "filling", "the status change rolled back with the failed activity row");
  assert.equal(await eventCount(id), 2);
  await assert.rejects(pool.query("UPDATE recruit_request_events SET to_status = 'closed' WHERE request_id = $1", [id]), /append-only/);
});

test("REC1_CANCEL closing as cancelled clears the recruiter in the same change; a recruiter grantee cannot close", async () => {
  const orgId = await organization(), storeId = await store(orgId), owner = await principal(orgId), recruiter = await principal(orgId, "recruiter"), staff = await principal("root", "staff", "subtree");
  const id = await create(orgId, recruiter, storeId);
  await pool.query("UPDATE recruit_requests SET assigned_recruiter_principal_id = $2, assigned_at = now() WHERE id = $1", [id, staff]);
  assert.deepEqual(await requests.transition(recruiter, id, "closed", "cancelled"), { kind: "not_found" });
  assert.equal((await statusOf(id)).status, "open");
  assert.deepEqual(await requests.transition(owner, id, "closed", "cancelled"), { kind: "transitioned", status: "closed" });
  assert.deepEqual(await statusOf(id), { status: "closed", close_reason: "cancelled", assigned_recruiter_principal_id: null });
  const kept = await create(orgId, owner, storeId);
  await pool.query("UPDATE recruit_requests SET assigned_recruiter_principal_id = $2, assigned_at = now() WHERE id = $1", [kept, staff]);
  assert.equal((await requests.transition(staff, kept, "closed", "fulfilled")).kind, "transitioned");
  assert.equal((await statusOf(kept)).assigned_recruiter_principal_id, staff, "a fulfilled close keeps the recruiter");
  assert.equal((await requests.get(recruiter, id))?.canTransition, false, "recruiter reads without actions");
});

test("REC1_READS company and staff pages: newest first, stable cursor, status filter, drafts hidden from staff, other companies invisible", async () => {
  const orgId = await organization(), other = await organization(), storeId = await store(orgId), otherStore = await store(other);
  const owner = await principal(orgId), otherOwner = await principal(other), staff = await principal("root", "staff", "subtree"), stranger = await principal(other, "recruiter");
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push(await create(orgId, owner, storeId, { positionTitle: `Role ${i}` }));
  const draft = await create(orgId, owner, storeId, { draft: true });
  const theirs = await create(other, otherOwner, otherStore);
  const first = await requests.listCompany(owner, orgId, { limit: 3 });
  assert.deepEqual(first?.map((r) => r.id), [draft, ids[4], ids[3]]);
  const last = first![2]!;
  const second = await requests.listCompany(owner, orgId, { limit: 3, cursor: { createdAt: last.cursor_at, id: last.id } });
  assert.deepEqual(second?.map((r) => r.id), [ids[2], ids[1], ids[0]]);
  assert.equal(second![0]!.store_name.startsWith("Store "), true);
  assert.deepEqual((await requests.listCompany(owner, orgId, { limit: 50, status: "draft" }))?.map((r) => r.id), [draft]);
  assert.equal(await requests.listCompany(stranger, orgId, { limit: 50 }), null);
  assert.equal(await requests.get(otherOwner, ids[0]!), null, "another company's request is invisible");
  assert.equal(await requests.listStaff(owner, { limit: 50 }), null, "owners are not staff");
  const staffPage = await requests.listStaff(staff, { limit: 500 });
  const seen = new Set(staffPage!.map((r) => r.id));
  assert.equal(seen.has(theirs) && seen.has(ids[0]!), true);
  assert.equal(seen.has(draft), false, "drafts stay off the staff queue");
  assert.deepEqual(await requests.listStaff(staff, { limit: 50, status: "draft" }), []);
});

test("REC1_RACE two simultaneous transitions of one request commit exactly one winner", async () => {
  const orgId = await organization(), storeId = await store(orgId), owner = await principal(orgId), staff = await principal("root", "staff", "subtree");
  for (let round = 0; round < 5; round += 1) {
    const id = await create(orgId, owner, storeId);
    const results = await Promise.all([requests.transition(owner, id, "filling", null), requests.transition(staff, id, "filling", null)]);
    assert.deepEqual(results.map((r) => r.kind).sort(), ["refused", "transitioned"], JSON.stringify(results));
    assert.deepEqual(results.find((r) => r.kind === "refused"), { kind: "refused", status: "filling" }, "the loser sees the changed status");
    assert.equal((await statusOf(id)).status, "filling");
    assert.equal(await eventCount(id), 2);
  }
});

test("REC1_REVOKE_RACE a grant revoked while a create or a transition is in flight refuses it; nothing is written", async () => {
  const orgId = await organization(), storeId = await store(orgId);
  const creator = await principal(orgId);
  assert.deepEqual(await revokeDuring(pool, creator, () => requests.create(creator, orgId, fields(storeId))), { kind: "not_found" });
  const owner = await principal(orgId), requestId = await create(orgId, owner, storeId);
  const closer = await principal(orgId);
  assert.deepEqual(await revokeDuring(pool, closer, () => requests.transition(closer, requestId, "closed", "cancelled")), { kind: "not_found" });
  assert.equal((await statusOf(requestId)).status, "open");
  assert.equal(await eventCount(requestId), 1);
});
