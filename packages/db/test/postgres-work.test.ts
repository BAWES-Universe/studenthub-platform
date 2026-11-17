import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresWorkPlacementStore, PostgresWorkSessionStore } from "@studenthub/db/work";
import { PlacementService, SessionService } from "../../work/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, placements: PostgresWorkPlacementStore, sessions: PostgresWorkSessionStore;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  placements = new PostgresWorkPlacementStore(pool);
  sessions = new PostgresWorkSessionStore(pool);
});
after(async () => pool.end());

const HERE = { latitude: 29.3759, longitude: 47.9774 };
const THERE = { latitude: 29.3117, longitude: 47.4818 };

async function principal(prefix: string, grants: { orgId: string; role: string; scope?: "self" | "subtree" }[] = []) {
  const id = `work-${prefix}-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  if (grants.length) await authz.grantMany(id, grants.map((g) => ({ orgId: g.orgId, role: g.role, scope: g.scope ?? "self" })) as never);
  return id;
}
async function world() {
  const group = `work-group-${randomUUID()}`, company = `work-co-${randomUUID()}`, rival = `work-rival-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: group, name: group }));
  await authz.upsertOrganization(createOrganization({ id: company, name: company, parentOrgId: group }));
  await authz.upsertOrganization(createOrganization({ id: rival, name: rival }));
  const store = randomUUID(), rivalStore = randomUUID();
  for (const [id, org] of [[store, company], [rivalStore, rival]] as const) {
    await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Avenues',$3,$3)", [id, org, "a".repeat(64)]);
  }
  const staff = await principal("staff", [{ orgId: group, role: "staff", scope: "subtree" }]);
  const owner = await principal("owner", [{ orgId: company, role: "org-owner" }]);
  const rivalOwner = await principal("rival", [{ orgId: rival, role: "org-owner" }]);
  const person = await principal("person");
  return { group, company, rival, store, rivalStore, staff, owner, rivalOwner, person };
}
async function contract(person: string, company: string, store: string, start = "2026-01-01") {
  const id = randomUUID(), currency = randomUUID();
  await pool.query("INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,status,created_by_ref,updated_by_ref,created_at,updated_at) VALUES($1,'currency',$2,$2,'active',$3,$3,now(),now())", [currency, `kwd-${currency}`, "a".repeat(64)]);
  await pool.query(`INSERT INTO pay_contracts(id,candidate_principal_id,company_org_id,store_id,pay_model,start_date,currency_id,transfer_cost,auto_generate,status,candidate_hourly_rate,company_hourly_rate,created_at,updated_at)
    VALUES($1,$2,$3,$4,'hourly',$5,$6,0,false,'active',1,2,clock_timestamp(),clock_timestamp())`, [id, person, company, store, start, currency]);
  return id;
}
function services(now: { value: Date }) {
  let n = 0;
  const newId = () => randomUUID() + (n++, "");
  return {
    placement: new PlacementService({ store: placements, grants: authz, newId, now: () => now.value }),
    session: new SessionService({ store: sessions, newId, now: () => now.value }),
  };
}
const events = async (subject: string) => (await pool.query("SELECT kind, actor_principal_id, detail FROM work_events WHERE subject_id = $1 ORDER BY id", [subject])).rows;

test("W1_PG staff place a person with the contract recorded; overlap and other companies are refused", async () => {
  const w = await world();
  const c = await contract(w.person, w.company, w.store);
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { placement } = services(now);
  assert.deepEqual(await placement.place(w.owner, { personId: w.person, storeId: w.store }), { kind: "refused", code: "forbidden" });
  const out = await placement.place(w.staff, { personId: w.person, storeId: w.store, startDate: "2026-11-01" });
  assert.equal(out.kind, "placed");
  const a = out.kind === "placed" ? out.assignment : undefined;
  assert.equal(a?.payContractId, c);
  assert.deepEqual(a?.warnings, ["civil_id_missing"]);
  const stored = await placements.assignment(a!.id);
  assert.deepEqual({ ...stored, createdAt: undefined }, { ...a, createdAt: undefined });
  assert.deepEqual(await placement.place(w.staff, { personId: w.person, storeId: w.rivalStore, startDate: "2026-11-20" }), { kind: "refused", code: "forbidden" });
  assert.deepEqual(await placement.place(w.staff, { personId: w.person, storeId: w.store, startDate: "2026-11-20" }), { kind: "refused", code: "overlaps_assignment" });
  assert.deepEqual((await events(a!.id)).map((e) => [e.kind, e.actor_principal_id]), [["assignment.created", w.staff]]);
  assert.equal((await placement.forOrganization(w.owner, w.company))?.length, 1);
  assert.equal(await placement.forOrganization(w.rivalOwner, w.company), undefined);
  assert.equal((await placement.mine(w.person)).length, 1);
});

test("W1_PG the database itself refuses overlap, a foreign contract, a removed store, edits and deletes", async () => {
  const w = await world();
  const foreign = await contract(await principal("other"), w.company, w.store);
  const insert = (id: string, start: string, end: string | null, contractId: string | null = null, store = w.store, org = w.company) => pool.query(
    `INSERT INTO work_assignments(id,person_principal_id,org_id,store_id,pay_contract_id,contract_resolution,start_date,end_date,source,created_by)
     VALUES($1,$2,$3,$4,$5,'{}',$6,$7,'staff',$8)`, [id, w.person, org, store, contractId, start, end, w.staff]);
  const first = randomUUID();
  await insert(first, "2026-01-01", "2026-06-30");
  await assert.rejects(insert(randomUUID(), "2026-06-30", null), { code: "23P01" });
  await assert.rejects(insert(randomUUID(), "2026-07-01", null, foreign), /does not bind/);
  await assert.rejects(insert(randomUUID(), "2026-07-01", null, null, w.store, w.rival), /another organization/);
  await assert.rejects(pool.query("UPDATE work_assignments SET start_date = '2025-01-01' WHERE id = $1", [first]), /only the end date/);
  await assert.rejects(pool.query("DELETE FROM work_assignments WHERE id = $1", [first]), /never deleted/);
  await pool.query("UPDATE organization_stores SET status='deleted', deleted_at=now() WHERE id=$1", [w.store]);
  await assert.rejects(insert(randomUUID(), "2026-07-01", null), /store is removed/);
  await assert.rejects(pool.query("UPDATE work_events SET kind = kind"), /append-only/);
});

test("W1_PG a company request is accepted by staff into a placement atomically", async () => {
  const w = await world();
  await contract(w.person, w.company, w.store);
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { placement } = services(now);
  const req = await placement.request(w.owner, { personId: w.person, storeId: w.store, note: "weekends" });
  assert.equal(req.kind, "requested");
  assert.deepEqual(await placement.request(w.owner, { personId: w.person, storeId: w.store }), { kind: "refused", code: "duplicate_request" });
  const id = req.kind === "requested" ? req.request.id : "";
  const accepted = await placement.decideRequest(w.staff, id, "accept");
  assert.equal(accepted.kind, "accepted");
  assert.equal((await placements.request(id))?.status, "accepted");
  assert.equal((await placements.request(id))?.decidedBy, w.staff);
  // A second accept of a decided request changes nothing.
  assert.deepEqual(await placement.decideRequest(w.staff, id, "accept"), { kind: "refused", code: "request_not_pending" });
  assert.equal((await placement.mine(w.person)).length, 1);
});

test("W1_PG accepting a request that overlaps leaves the request pending and writes nothing", async () => {
  const w = await world();
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { placement } = services(now);
  assert.equal((await placement.place(w.staff, { personId: w.person, storeId: w.store, startDate: "2026-11-01" })).kind, "placed");
  const req = await placement.request(w.owner, { personId: w.person, storeId: w.store });
  const id = req.kind === "requested" ? req.request.id : "";
  assert.deepEqual(await placement.decideRequest(w.staff, id, "accept"), { kind: "refused", code: "overlaps_assignment" });
  assert.equal((await placements.request(id))?.status, "pending");
  assert.deepEqual((await events(id)).map((e) => e.kind), ["assignment_request.created"]);
});

test("W3_PG clock in and out with both locations; totals split by status; open session blocks ending", async () => {
  const w = await world();
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { placement, session } = services(now);
  const placed = await placement.place(w.staff, { personId: w.person, storeId: w.store, startDate: "2026-11-01" });
  const assignmentId = placed.kind === "placed" ? placed.assignment.id : "";
  assert.equal((await session.start(w.person, HERE)).kind, "started");
  assert.deepEqual(await session.start(w.person, HERE), { kind: "refused", code: "already_working" });
  assert.deepEqual(await placement.setEndDate(w.staff, assignmentId, "2026-11-18"), { kind: "refused", code: "open_session" });
  const open = await sessions.dayTotals({ personId: w.person, from: "2026-11-18", to: "2026-11-18" });
  assert.equal(open[0]?.openCount, 1);
  assert.equal(open[0]?.pendingSeconds, 0);
  now.value = new Date("2026-11-18T09:25:09.900Z");
  const stopped = await session.stop(w.person, THERE);
  assert.equal(stopped.kind, "stopped");
  const s = stopped.kind === "stopped" ? stopped.session : undefined;
  assert.deepEqual([s?.startLocation, s?.endLocation, s?.durationSeconds], [HERE, THERE, 12309]);
  assert.deepEqual(await sessions.session(s!.id), s);
  now.value = new Date("2026-11-18T12:00:00Z");
  const manual = await session.addManual(w.person, { startedAt: "2026-11-18T13:00:00+03:00", endedAt: "2026-11-18T14:00:00+03:00" });
  assert.equal(manual.kind, "added");
  assert.deepEqual(await session.addManual(w.person, { startedAt: "2026-11-18T13:30:00+03:00", endedAt: "2026-11-18T14:30:00+03:00" }), { kind: "refused", code: "overlaps_session" });
  // Decisions arrive with W-4; set statuses directly to check the split.
  await pool.query("UPDATE work_sessions SET status='approved' WHERE id=$1", [s!.id]);
  await pool.query("UPDATE work_sessions SET status='rejected' WHERE id=$1", [manual.kind === "added" ? manual.session.id : ""]);
  const [day] = await sessions.dayTotals({ orgIds: [w.group], from: "2026-11-18", to: "2026-11-18" });
  assert.deepEqual([day?.approvedSeconds, day?.pendingSeconds, day?.rejectedSeconds, day?.approvedCount, day?.rejectedCount, day?.openCount], [12309, 0, 3600, 1, 1, 0]);
  assert.equal((await sessions.dayTotals({ orgIds: [w.rival], from: "2026-11-18", to: "2026-11-18" })).length, 0);
  assert.deepEqual(await placement.setEndDate(w.staff, assignmentId, "2026-11-18"), { kind: "ended", endDate: "2026-11-18" });
  assert.deepEqual((await events(s!.id)).map((e) => e.kind), ["session.started", "session.stopped"]);
});

test("W3_PG the database refuses a second open session, editing a closed one, deciding an open one and hard deletes", async () => {
  const w = await world();
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { placement, session } = services(now);
  const placed = await placement.place(w.staff, { personId: w.person, storeId: w.store, startDate: "2026-11-01" });
  const a = placed.kind === "placed" ? placed.assignment : undefined;
  const started = await session.start(w.person, HERE);
  const id = started.kind === "started" ? started.session.id : "";
  await assert.rejects(pool.query(`INSERT INTO work_sessions(id,assignment_id,person_principal_id,org_id,store_id,work_date,started_at,start_latitude,start_longitude,source,created_by)
    VALUES($1,$2,$3,$4,$5,'2026-11-18',now() + interval '1 day',1,1,'timer',$3)`, [randomUUID(), a!.id, w.person, w.company, w.store]), { code: "23P01" });
  await assert.rejects(pool.query("UPDATE work_sessions SET status='approved' WHERE id=$1", [id]), /open session cannot be decided/);
  now.value = new Date("2026-11-18T07:00:00Z");
  await session.stop(w.person, THERE);
  await assert.rejects(pool.query("UPDATE work_sessions SET ended_at = ended_at + interval '1 hour' WHERE id=$1", [id]), /corrected by a new session/);
  await assert.rejects(pool.query("DELETE FROM work_sessions WHERE id=$1", [id]), /soft-deleted/);
  await assert.rejects(pool.query(`INSERT INTO work_sessions(id,assignment_id,person_principal_id,org_id,store_id,work_date,started_at,ended_at,source,created_by)
    VALUES($1,$2,$3,$4,$5,'2026-10-01','2026-10-01T06:00:00Z','2026-10-01T07:00:00Z','manual',$3)`, [randomUUID(), a!.id, w.person, w.company, w.store]), /outside its assignment/);
  await assert.rejects(pool.query(`INSERT INTO work_sessions(id,assignment_id,person_principal_id,org_id,store_id,work_date,started_at,ended_at,source,created_by)
    VALUES($1,$2,$3,$4,$5,'2026-11-18','2026-11-18T07:00:00Z','2026-11-18T06:00:00Z','manual',$3)`, [randomUUID(), a!.id, w.person, w.company, w.store]), { code: "23514" });
});

test("W3_PG discard soft-deletes; the discarded time leaves the totals and a new start is allowed", async () => {
  const w = await world();
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { placement, session } = services(now);
  await placement.place(w.staff, { personId: w.person, storeId: w.store, startDate: "2026-11-01" });
  const started = await session.start(w.person, HERE);
  assert.deepEqual(await session.discard(w.person), { kind: "discarded" });
  const row = (await pool.query("SELECT deleted_at IS NOT NULL AS gone, deleted_by, delete_reason FROM work_sessions WHERE id=$1", [started.kind === "started" ? started.session.id : ""])).rows[0];
  assert.deepEqual(row, { gone: true, deleted_by: w.person, delete_reason: "discarded by the person" });
  assert.equal((await sessions.dayTotals({ personId: w.person, from: "2026-11-18", to: "2026-11-18" })).length, 0);
  assert.equal((await session.start(w.person, HERE)).kind, "started");
});

test("W1_PG recruit placement is idempotent on the card, also under a race", async () => {
  const w = await world();
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { placement } = services(now);
  const card = randomUUID();
  const input = { recruitCardId: card, requestId: randomUUID(), personId: w.person, storeId: w.store, startDate: "2026-11-20", endDate: null };
  const [a, b] = await Promise.all([placement.placeFromRecruit(w.staff, input), placement.placeFromRecruit(w.staff, input)]);
  assert.equal(a.kind, "placed");
  assert.equal(b.kind, "placed");
  const ids = new Set([a, b].map((x) => x.kind === "placed" ? x.assignmentId : ""));
  assert.equal(ids.size, 1);
  assert.deepEqual([a, b].map((x) => x.kind === "placed" && x.created).sort(), [false, true]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM work_assignments WHERE recruit_card_id = $1", [card])).rows[0].n, 1);
});
