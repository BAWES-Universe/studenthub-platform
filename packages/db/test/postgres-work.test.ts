import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresWorkAppealStore, PostgresWorkDecisionStore, PostgresWorkHoursViewStore, PostgresWorkPayableSource, PostgresWorkPlacementStore, PostgresWorkSessionStore } from "@studenthub/db/work";
import { AppealService, DecisionService, HoursViews, PlacementService, SessionService, WorkScope } from "../../work/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, placements: PostgresWorkPlacementStore, sessions: PostgresWorkSessionStore, decisionStore: PostgresWorkDecisionStore, viewStore: PostgresWorkHoursViewStore;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  placements = new PostgresWorkPlacementStore(pool);
  sessions = new PostgresWorkSessionStore(pool);
  decisionStore = new PostgresWorkDecisionStore(pool);
  viewStore = new PostgresWorkHoursViewStore(pool);
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
    decision: new DecisionService({ store: decisionStore, grants: authz, newId, now: () => now.value }),
    views: new HoursViews(viewStore, new WorkScope(authz, { managedStores: async () => [] }, (o) => viewStore.organizationAncestors(o)), async () => []),
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

async function workedDay(w: Awaited<ReturnType<typeof world>>, now: { value: Date }) {
  const { placement, session } = services(now);
  await placement.place(w.staff, { personId: w.person, storeId: w.store, startDate: "2026-11-01" });
  const ids: string[] = [];
  for (const [start, end] of [["06:00", "08:00"], ["09:00", "10:00"], ["11:00", "11:30"]] as const) {
    const out = await session.addManual(w.person, { startedAt: `2026-11-18T${start}:00Z`, endedAt: `2026-11-18T${end}:00Z` });
    ids.push(out.kind === "added" ? out.session.id : "");
  }
  return ids;
}

test("W4_PG decisions are scoped, all or nothing, and recorded once; the day path skips decided sessions", async () => {
  const w = await world();
  const now = { value: new Date("2026-11-19T06:00:00Z") };
  const { decision } = services(now);
  const [a, b, c] = await workedDay(w, now);
  assert.deepEqual(await decision.decideSessions(w.rivalOwner, [a], { decision: "approve" }), { kind: "refused", code: "session_not_found", index: 0 });
  assert.deepEqual(await decision.decideSessions(w.owner, [a, randomUUID()], { decision: "approve" }), { kind: "refused", code: "session_not_found", index: 1 });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM work_decisions WHERE person_principal_id = $1", [w.person])).rows[0].n, 0);
  assert.equal((await decision.decideSessions(w.owner, [b], { decision: "reject", reason: "break", rating: 2 })).kind, "decided");
  const day = await decision.decideDays(w.owner, [{ personId: w.person, storeId: w.store, workDate: "2026-11-18" }], { decision: "approve" });
  assert.equal(day.kind === "decided" && day.changed, 2);
  const rows = (await pool.query("SELECT id, status, decision_id FROM work_sessions WHERE id = ANY($1::uuid[]) ORDER BY started_at", [[a, b, c]])).rows;
  assert.deepEqual(rows.map((r) => r.status), ["approved", "rejected", "approved"]);
  const [total] = await sessions.dayTotals({ personId: w.person, from: "2026-11-18", to: "2026-11-18" });
  assert.deepEqual([total?.approvedSeconds, total?.rejectedSeconds, total?.pendingSeconds], [9000, 3600, 0]);
  await assert.rejects(pool.query("UPDATE work_decisions SET reason = 'x'"), /append-only/);
  await assert.rejects(pool.query("UPDATE work_sessions SET decision_id = $2 WHERE id = $1", [a, rows[1].decision_id]), /does not name this session/);
  assert.equal((await decision.undo(w.owner, b, "mistake")).kind, "decided");
  assert.equal((await pool.query("SELECT status FROM work_sessions WHERE id = $1", [b])).rows[0].status, "pending");
  assert.deepEqual((await events(b)).map((e) => e.kind), ["session.added", "session.rejected", "session.undone"]);
});

test("W4_PG notification hooks run on the decision's own transaction; a hook failure rolls the decision back", async () => {
  const w = await world();
  const now = { value: new Date("2026-11-19T06:00:00Z") };
  const [a] = await workedDay(w, now);
  const seen: string[] = [];
  let fail = true;
  const hooked = new PostgresWorkDecisionStore(pool, {
    async onDecided(client, input) {
      // The hook sees the uncommitted decision through its own client.
      const { rows } = await client.query("SELECT status FROM work_sessions WHERE id = $1", [input.sessionId]);
      seen.push(`decided:${input.decision}:${rows[0].status}:${input.personPrincipalId === w.person}`);
      if (fail) throw new Error("comms down");
    },
    async onUndone(_client, input) { seen.push(`undone:${input.decisionId}`); },
  });
  let n = 0;
  const svc = new DecisionService({ store: hooked, grants: authz, newId: () => randomUUID() + (n++, ""), now: () => now.value });
  await assert.rejects(svc.decideSessions(w.owner, [a], { decision: "approve" }), /comms down/);
  assert.equal((await pool.query("SELECT status FROM work_sessions WHERE id = $1", [a])).rows[0].status, "pending");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM work_decisions WHERE $1 = ANY(session_ids)", [a])).rows[0].n, 0);
  fail = false;
  const out = await svc.decideSessions(w.owner, [a], { decision: "approve" });
  assert.equal(out.kind, "decided");
  await svc.undo(w.owner, a);
  assert.deepEqual(seen, ["decided:approved:approved:true", "decided:approved:approved:true", `undone:${out.kind === "decided" ? out.decisions[0]!.id : ""}`]);
});

test("W5_PG views: the person sees no rating or private note; another company sees nothing; totals split; paging stable", async () => {
  const w = await world();
  const now = { value: new Date("2026-11-19T06:00:00Z") };
  const { decision, views } = services(now);
  const [a, b] = await workedDay(w, now);
  await decision.decideSessions(w.owner, [a], { decision: "approve", note: "private note", rating: 4 });
  await decision.decideSessions(w.owner, [b], { decision: "reject", reason: "late", note: "public note", notePublic: true });
  const range = { from: "2026-11-01", to: "2026-11-30" };
  const mine = await views.mine(w.person, range, null);
  assert.equal(mine.rows.length, 3);
  assert.equal(JSON.stringify(mine).includes("private note"), false);
  assert.equal(JSON.stringify(mine).includes("rating"), false);
  assert.equal(mine.rows.find((r) => r.session.id === b)?.decision?.note, "public note");
  assert.deepEqual(mine.totals, { approvedSeconds: 7200, pendingSeconds: 1800, rejectedSeconds: 3600, open: 0 });
  const company = await views.company(w.owner, w.company, range);
  assert.equal("rows" in company && company.rows.find((r) => r.session.id === a)?.decision?.rating, 4);
  assert.deepEqual(await views.company(w.rivalOwner, w.company, range), { kind: "refused", code: "forbidden" });
  const group = await views.company(w.staff, w.group, range, { status: "rejected" });
  assert.deepEqual("rows" in group && group.rows.map((r) => r.session.id), [b]);
  const first = await viewStore.listSessions({ personId: w.person, range, limit: 2 });
  const rest = await viewStore.listSessions({ personId: w.person, range, limit: 2, after: { workDate: first[1]!.workDate, id: first[1]!.id } });
  assert.deepEqual([...first, ...rest].map((s) => s.id).sort(), [a, b, (await viewStore.listSessions({ personId: w.person, range, limit: 10 })).map((s) => s.id).find((id) => id !== a && id !== b)].sort());
  assert.equal(rest.length, 1);
});

function appealService(now: { value: Date }) {
  const store = new PostgresWorkAppealStore(pool);
  let n = 0;
  return new AppealService({ store, scope: new WorkScope(authz, { managedStores: async () => [] }, (o) => store.organizationAncestors(o)), newId: () => randomUUID() + (n++, ""), now: () => now.value });
}

test("W6_PG appeals: own session only, staff answer, the appellant marks read, rows are append-only", async () => {
  const w = await world();
  const now = { value: new Date("2026-11-19T06:00:00Z") };
  const [a] = await workedDay(w, now);
  const appeals = appealService(now);
  const raised = await appeals.raise(w.person, a, "I stayed until 9");
  assert.equal(raised.kind, "raised");
  const appealId = raised.kind === "raised" ? raised.appeal.id : "";
  assert.deepEqual(await appeals.raise(w.owner, a, "not mine"), { kind: "refused", code: "session_not_found" });
  await assert.rejects(pool.query("INSERT INTO work_appeals(id, session_id, person_principal_id, org_id, store_id, reason) VALUES($1,$2,$3,$4,$5,'x')",
    [randomUUID(), a, w.owner, w.company, w.store]), /session of the appellant/);
  assert.deepEqual(await appeals.postUpdate(w.owner, appealId, { detail: "no" }), { kind: "refused", code: "appeal_not_found" });
  const posted = await appeals.postUpdate(w.staff, appealId, { title: "Checking", detail: "Looking at the store log" });
  assert.equal(posted.kind, "posted");
  const updateId = posted.kind === "posted" ? posted.update.id : "";
  assert.deepEqual(await appeals.markRead(w.owner, updateId), { kind: "refused", code: "update_not_found" });
  assert.deepEqual(await appeals.markRead(w.person, updateId), { kind: "read" });
  await assert.rejects(pool.query("UPDATE work_appeal_updates SET detail = 'x' WHERE id = $1", [updateId]), /append-only/);
  await assert.rejects(pool.query("UPDATE work_appeals SET reason = 'x' WHERE id = $1", [appealId]), /only the status/);
  await assert.rejects(pool.query("DELETE FROM work_appeals WHERE id = $1", [appealId]), /never removed/);
  assert.equal((await appeals.setStatus(w.staff, appealId, "resolved")).kind, "updated");
  const listed = await appeals.list(w.staff, { orgId: w.group, status: "resolved" });
  assert.deepEqual(Array.isArray(listed) && listed.map((x) => x.id), [appealId]);
  assert.deepEqual((await events(appealId)).map((e) => e.kind), ["appeal.raised", "appeal.updated", "appeal.status_changed"]);
});

test("W6_PG a staff correction replaces the original in totals and in pay input; the original row is kept", async () => {
  const w = await world();
  const now = { value: new Date("2026-11-19T06:00:00Z") };
  const { decision } = services(now);
  const [a, b, c] = await workedDay(w, now);
  await decision.decideDays(w.owner, [{ personId: w.person, storeId: w.store, workDate: "2026-11-18" }], { decision: "approve" });
  await decision.decideSessions(w.owner, [c!], { decision: "reject", reason: "no show" });
  const appeals = appealService(now);
  const raised = await appeals.raise(w.person, a, "I stayed until 9");
  const appealId = raised.kind === "raised" ? raised.appeal.id : "";
  // Overlapping b (09:00-10:00) is refused by the database's overlap rule.
  assert.deepEqual(await appeals.correct(w.staff, a, { startedAt: "2026-11-18T06:00:00Z", endedAt: "2026-11-18T09:30:00Z", reason: "log" }), { kind: "refused", code: "overlaps_session" });
  const fixed = await appeals.correct(w.staff, a, { startedAt: "2026-11-18T05:00:00Z", endedAt: "2026-11-18T09:00:00Z", reason: "store log", appealId });
  assert.equal(fixed.kind, "entered");
  const correctionId = fixed.kind === "entered" ? fixed.session.id : "";
  assert.deepEqual(await appeals.correct(w.staff, a, { startedAt: "2026-11-18T05:00:00Z", endedAt: "2026-11-18T06:00:00Z", reason: "again" }), { kind: "refused", code: "session_replaced" });
  const added = await appeals.addMissing(w.staff, appealId, { startedAt: "2026-11-18T14:00:00Z", endedAt: "2026-11-18T15:00:00Z", reason: "evening confirmed" });
  assert.equal(added.kind, "entered");
  const [total] = await sessions.dayTotals({ personId: w.person, from: "2026-11-18", to: "2026-11-18" });
  // 4h correction + 1h b + 1h added approved; 30m c rejected; the original 2h is gone from the totals.
  assert.deepEqual([total?.approvedSeconds, total?.rejectedSeconds, total?.approvedCount], [6 * 3600, 1800, 3]);
  assert.equal((await pool.query("SELECT deleted_at FROM work_sessions WHERE id = $1", [a])).rows[0].deleted_at, null);
  await assert.rejects(pool.query("UPDATE work_sessions SET appeal_id = NULL WHERE id = $1", [correctionId]), /identity fields are fixed/);
  const detail = await appeals.detail(w.person, appealId);
  assert.equal("entries" in detail && detail.entries.length, 2);

  const pay = new PostgresWorkPayableSource(pool);
  const [input, ...rest] = await pay.payableInputs({ period: { start: "2026-11-01", end: "2026-11-30" }, personId: w.person });
  assert.equal(rest.length, 0);
  assert.deepEqual([input?.approvedSeconds, input?.rejectedSeconds, input?.pendingSeconds, input?.openSessions, input?.storeId], [6 * 3600, 1800, 0, 0, w.store]);
  assert.deepEqual(input?.sessions.map((s) => [s.sessionId, s.source, s.correctsSessionId]),
    [[correctionId, "correction", a], [b, "manual", null], [added.kind === "entered" ? added.session.id : "", "manual", null]]);
  assert.ok(input?.sessions.every((s) => s.decisionId !== null && /Z$/.test(s.changedAt)));
  assert.deepEqual(await pay.payableInputs({ period: { start: "2026-11-01", end: "2026-11-30" }, orgId: w.rival, includeSubtree: true }), []);
  assert.equal((await pay.payableInputs({ period: { start: "2026-11-01", end: "2026-11-30" }, orgId: w.group, includeSubtree: true, personId: w.person })).length, 1);
  assert.equal((await pay.payableInputs({ period: { start: "2026-11-01", end: "2026-11-30" }, orgId: w.group, personId: w.person })).length, 0);
  await assert.rejects(pay.payableInputs({ period: { start: "2026-11-30", end: "2026-11-01" } }), RangeError);
});
