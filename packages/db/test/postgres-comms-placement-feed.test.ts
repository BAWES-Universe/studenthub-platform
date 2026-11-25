import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresNotificationsStore, runMigrations } from "@studenthub/db";
import { PostgresPlacementFeedStore } from "@studenthub/db/comms";
import { PostgresWorkPlacementStore } from "@studenthub/db/work";
import { PlacementService } from "../../work/src/index.js";
import { NotificationsService } from "../../notifications/src/notifications.js";
import { dispatchPlacementsThen } from "../../comms/src/placement-feed.js";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, feed: PostgresPlacementFeedStore, placement: PlacementService;
const now = { value: new Date("2026-11-18T06:00:00Z") };
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  feed = new PostgresPlacementFeedStore({ pool });
  placement = new PlacementService({ store: new PostgresWorkPlacementStore(pool), grants: authz, newId: () => randomUUID(), now: () => now.value });
});
after(async () => pool.end());

async function principal(prefix: string, grants: { orgId: string; role: string; scope: "self" | "subtree" }[] = []) {
  const id = `pf-${prefix}-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  if (grants.length) await authz.grantMany(id, grants as never);
  return id;
}
async function world(companyName: string, storeName: string) {
  const group = `pf-group-${randomUUID()}`, company = `pf-co-${randomUUID()}`, store = randomUUID();
  await authz.upsertOrganization(createOrganization({ id: group, name: group }));
  await authz.upsertOrganization(createOrganization({ id: company, name: companyName, parentOrgId: group }));
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,$3,$4,$4)", [store, company, storeName, "a".repeat(64)]);
  const staff = await principal("staff", [{ orgId: group, role: "staff", scope: "subtree" }]);
  return { company, store, staff };
}
async function contract(person: string, company: string, store: string) {
  const id = randomUUID(), currency = randomUUID();
  await pool.query("INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,status,created_by_ref,updated_by_ref,created_at,updated_at) VALUES($1,'currency',$2,$2,'active',$3,$3,now(),now())", [currency, `kwd-${currency}`, "a".repeat(64)]);
  await pool.query(`INSERT INTO pay_contracts(id,candidate_principal_id,company_org_id,store_id,pay_model,start_date,currency_id,transfer_cost,auto_generate,status,candidate_hourly_rate,company_hourly_rate,created_at,updated_at)
    VALUES($1,$2,$3,$4,'hourly','2026-01-01',$5,0,false,'active',1,2,clock_timestamp(),clock_timestamp())`, [id, person, company, store, currency]);
}
async function place(companyName = "Sultan Co", storeName = "Avenues", startDate = "2026-11-20") {
  const w = await world(companyName, storeName), person = await principal("person");
  await contract(person, w.company, w.store);
  const out = await placement.place(w.staff, { personId: person, storeId: w.store, startDate });
  assert.equal(out.kind, "placed");
  return { ...w, person, assignmentId: out.kind === "placed" ? out.assignment.id : "" };
}
async function drain() { let total = 0; for (let n; (n = await feed.dispatch(1000, new Date())) > 0;) total += n; return total; }
const items = async (person: string) => (await pool.query("SELECT kind, subject_reference, parameters, created_at FROM notifications WHERE recipient_principal_id = $1", [person])).rows;

test("COMMS_PLACEMENT_FEED_PG a new placement reaches the placed person's feed once, dated when it was made", async () => {
  await drain();
  const p = await place();
  assert.deepEqual(await items(p.person), [], "nothing before the job runs");
  assert.equal(await drain(), 1);
  assert.equal(await feed.dispatch(1000, new Date()), 0, "nothing left");
  const event = (await pool.query("SELECT occurred_at FROM work_events WHERE subject_id = $1 AND kind = 'assignment.created'", [p.assignmentId])).rows[0];
  assert.deepEqual(await items(p.person), [{ kind: "work.assigned", subject_reference: `work_assignment:${p.assignmentId}`, parameters: {}, created_at: event.occurred_at }]);
  assert.deepEqual(await items(p.staff), [], "the staff member who placed them gets nothing");
});

test("COMMS_PLACEMENT_FEED_RENDER the item reads the placement as it is now, opens the work page, and the bell counts it", async () => {
  await drain();
  const p = await place("Sultan Co", "Avenues", "2026-11-21");
  await drain();
  const store = PostgresNotificationsStore.connect({ pool }), service = new NotificationsService(store, store, authz);
  await pool.query("UPDATE organizations SET name = 'Sultan Group' WHERE id = $1", [p.company]);
  const page = await service.list(p.person, 1, ["work.assigned"]);
  assert.deepEqual(page.items.map((i) => [i.text, i.href, i.read]), [["You were placed at Avenues, Sultan Group, starting 2026-11-21.", "/work", false]]);
  assert.equal(await service.count(p.person), 1);
  // Someone else's placement is never read for this person, even with the reference in hand.
  const other = await principal("other");
  assert.deepEqual(await store.readPlacements(other, [p.assignmentId]), []);
  assert.deepEqual(await store.readPlacements(p.person, ["not-a-uuid"]), []);
  await service.markAllRead(p.person);
  assert.equal(await service.count(p.person), 0);
});

test("COMMS_PLACEMENT_FEED_ONCE racing workers write one item, and an event already marked is never dispatched", async () => {
  await drain();
  const p = await place();
  const results = await Promise.all([feed.dispatch(1000, new Date()), feed.dispatch(1000, new Date()), feed.dispatch(1000, new Date())]);
  assert.equal(results.reduce((a, b) => a + b, 0), 1);
  assert.equal((await items(p.person)).length, 1);
  const q = await place();
  await pool.query("INSERT INTO comms_dispatched_work_events(event_id, dispatched_at) SELECT id, now() FROM work_events WHERE subject_id = $1 AND kind = 'assignment.created'", [q.assignmentId]);
  assert.equal(await drain(), 0);
  assert.deepEqual(await items(q.person), []);
});

test("COMMS_PLACEMENT_FEED_EVENTS only placement events are dispatched", async () => {
  await drain();
  const p = await place();
  await pool.query("UPDATE work_assignments SET end_date = '2026-12-31' WHERE id = $1", [p.assignmentId]);
  await pool.query("INSERT INTO work_events(kind,org_id,person_principal_id,subject_id,actor_principal_id,detail) VALUES('assignment.ended',$1,$2,$3,$4,'{}'::jsonb)", [p.company, p.person, p.assignmentId, p.staff]);
  assert.equal(await drain(), 1);
  assert.deepEqual((await items(p.person)).map((r) => r.kind), ["work.assigned"], "an ended placement adds nothing (legacy's type 2 was switched off)");
});

test("COMMS_PLACEMENT_FEED_PAYLOAD the database takes only an empty payload and a placement reference for the kind", async () => {
  const person = await principal("payload");
  const insert = (reference: string, parameters: string) => pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,'work.assigned',$2,$3::jsonb,$4)", [person, reference, parameters, `k-${randomUUID()}`]);
  await assert.rejects(insert(`work_assignment:${randomUUID()}`, '{"startDate":"2026-11-20"}'), { code: "23514" });
  await assert.rejects(insert("work_assignment:nope", "{}"), { code: "23514" });
  await assert.rejects(insert(`work_session:${randomUUID()}`, "{}"), { code: "23514" });
  await insert(`work_assignment:${randomUUID()}`, "{}");
});

test("COMMS_PLACEMENT_FEED_JOB a failed dispatch still lets the rest of the run go, then raises", async () => {
  let ran = false;
  await assert.rejects(dispatchPlacementsThen({ dispatch: async () => { throw new Error("down"); } }, async () => { ran = true; return 3; }), /down/);
  assert.equal(ran, true);
  const asked: number[] = [];
  assert.equal(await dispatchPlacementsThen({ dispatch: async (limit) => { asked.push(limit); return 0; } }, async () => 5), 5);
  assert.deepEqual(asked, [200]);
});
