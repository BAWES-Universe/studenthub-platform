import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresEmailOutboxStore } from "@studenthub/db/notifications";
import { PostgresFiringSpikeStore } from "@studenthub/db/reports";
import { EmailOutboxService, FakeEmailPort, validateTemplateParameters } from "../../notifications/src/index.js";
import { FiringHitMapService, firingSpikes, lastTwelveMonths } from "../../reports/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
const OPS = `fs-ops-${randomUUID()}`;
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresFiringSpikeStore, creator: string;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: OPS, name: "Operator" }));
  store = new PostgresFiringSpikeStore({ pool, operatorOrgIds: [OPS] });
  creator = await principal("creator");
});
after(async () => pool.end());

async function principal(prefix: string, grants: { orgId: string; role: string; scope: "self" | "subtree" }[] = []) {
  const id = `fs-${prefix}-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  if (grants.length) await authz.grantMany(id, grants as never);
  return id;
}
async function company(name: string): Promise<{ id: string; place: (start: string, end: string) => Promise<unknown> }> {
  const id = `fs-co-${randomUUID()}`, storeId = randomUUID();
  await authz.upsertOrganization(createOrganization({ id, name, parentOrgId: OPS }));
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Mall',$3,$3)", [storeId, id, "a".repeat(64)]);
  return { id, place: async (start, end) => pool.query(`INSERT INTO work_assignments(id,person_principal_id,org_id,store_id,contract_resolution,start_date,end_date,source,created_by)
    VALUES($1,$2,$3,$4,'{}',$5,$6,'staff',$7)`, [randomUUID(), await principal("worker"), id, storeId, start, end, creator]) };
}
// A far past Kuwait day no earlier run holds, reserved for this suite.
async function freshDay(): Promise<string> {
  for (;;) {
    const day = new Date(Date.UTC(1975, 0, 1) + Math.floor(Math.random() * 15_000) * 86_400_000).toISOString().slice(0, 10);
    if (Number(day.slice(8)) < 10) continue; // leave room for placements ended earlier in the month
    if (!(await pool.query("SELECT 1 FROM firing_spike_runs WHERE day = $1::date", [day])).rowCount) return day;
  }
}
const ym = (day: string) => day.slice(0, 7);

test("REPORTS_FIRING_SPIKE_PG a day's check runs once; each company and month alerts once, to subscribed staff only", async () => {
  const staff = await principal("staff", [{ orgId: OPS, role: "staff", scope: "subtree" }]), quiet = await principal("quiet", [{ orgId: OPS, role: "staff", scope: "subtree" }]);
  const outsider = await principal("outsider");
  const service = new FiringHitMapService({ async firings() { return { companies: [], counts: [] }; } }, { isStaff: async id => id !== outsider }, () => new Date());
  assert.equal(await service.subscribe(staff, true), false, "not wired without subscriptions");
  const wired = new FiringHitMapService({ async firings() { return { companies: [], counts: [] }; } }, { isStaff: async id => id !== outsider }, () => new Date(), store);
  assert.equal(await wired.subscribe(staff, true), true);
  assert.equal(await wired.subscribe(outsider, true), false);
  assert.equal(await store.isSubscribed(outsider), false);
  await pool.query("INSERT INTO firing_spike_subscriptions(principal_id) VALUES($1)", [outsider]); // subscribed but not staff: never a recipient
  const day = await freshDay(), months = lastTwelveMonths(day);
  const spiky = await company("Spiky Co"), calm = await company("Calm Co");
  await spiky.place(`${months[3]}-01`, `${months[3]}-05`);
  await spiky.place(`${ym(day)}-01`, `${ym(day)}-02`);
  await spiky.place(`${ym(day)}-01`, `${ym(day)}-03`);
  for (const m of months.slice(1)) await calm.place(`${m}-01`, `${m}-10`);
  await calm.place(`${ym(day)}-01`, `${ym(day)}-04`);
  const mine = new Set([spiky.id, calm.id]);
  const decide = (d: string) => (data: { companies: readonly { orgId: string; name: string }[]; counts: readonly { orgId: string; month: string; total: number }[] }) =>
    firingSpikes(d, data.companies.filter(c => mine.has(c.orgId)), data.counts);
  const at = new Date(`${day}T06:00:00Z`);
  // A day with nobody subscribed records nothing, so the month can still alert later.
  const empty = new PostgresFiringSpikeStore({ pool, operatorOrgIds: [`fs-none-${randomUUID()}`] }), before = await freshDay();
  assert.deepEqual(await empty.sendDay(before, lastTwelveMonths(before), at, () => [{ orgId: spiky.id, month: ym(day), parameters: { company: "Spiky Co", month: ym(day), level: "danger", total: 2, twelveMonthTotal: 3 } }]), { alerts: 0 });
  assert.deepEqual(await store.sendDay(day, months, at, decide(day)), { alerts: 1 }, "Spiky Co: 2 this month of 3 in 12 is danger; Calm Co is at its average");
  assert.equal(await store.sendDay(day, months, at, decide(day)), null, "the day ran");
  const alert = (await pool.query("SELECT org_id, month, level, total, twelve_month_total, recipients FROM firing_spike_alerts WHERE org_id = ANY($1::text[])", [[...mine]])).rows;
  assert.deepEqual(alert, [{ org_id: spiky.id, month: ym(day), level: "danger", total: 2, twelve_month_total: 3, recipients: (await store.recipients()).length }]);
  const queued = (await pool.query("SELECT recipient_principal_id, template_parameters, idempotency_key FROM email_outbox WHERE idempotency_key LIKE $1", [`staff.firing_spike:${spiky.id}:%`])).rows;
  const people = new Set([staff, quiet, outsider]);
  assert.deepEqual(queued.filter(r => people.has(r.recipient_principal_id)).map(r => r.recipient_principal_id), [staff], "subscribed staff only");
  assert.equal(queued.find(r => r.recipient_principal_id === staff)!.idempotency_key, `staff.firing_spike:${spiky.id}:${ym(day)}:${staff}`);
  assert.deepEqual(validateTemplateParameters("staff.firing_spike", queued[0]!.template_parameters), { company: "Spiky Co", month: ym(day), level: "danger", total: 2, twelveMonthTotal: 3 });

  // The next day the month is worse, but it already alerted.
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  if (ym(next) === ym(day) && !(await pool.query("SELECT 1 FROM firing_spike_runs WHERE day = $1::date", [next])).rowCount) {
    await spiky.place(`${ym(day)}-01`, day);
    assert.deepEqual(await store.sendDay(next, lastTwelveMonths(next), new Date(`${next}T06:00:00Z`), decide(next)), { alerts: 0 });
  }
  // A check that fails to decide sends nothing and leaves the day due.
  const failing = await freshDay();
  await assert.rejects(store.sendDay(failing, lastTwelveMonths(failing), at, () => { throw new TypeError("invalid closed email template parameters"); }), /closed/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM firing_spike_runs WHERE day=$1::date", [failing])).rows[0].n, 0);
  await assert.rejects(store.sendDay("nope", months, at, decide(day)), RangeError);
  await wired.subscribe(staff, false);
  assert.equal(await store.isSubscribed(staff), false);
  await pool.query("UPDATE email_outbox SET state='not_sent' WHERE idempotency_key LIKE 'staff.firing_spike:%' AND state='pending' AND recipient_principal_id LIKE 'fs-%'");
});

test("REPORTS_FIRING_SPIKE_PG every delivery attempt rechecks the recipient: unsubscribed, no longer staff or paused after queueing is suppressed", async () => {
  await pool.query("UPDATE email_outbox SET state='suppressed' WHERE state IN ('pending','sending')");
  const grant = [{ orgId: OPS, role: "staff", scope: "subtree" as const }];
  const [kept, left, demoted, paused] = [await principal("kept", grant), await principal("left", grant), await principal("demoted", grant), await principal("paused", grant)];
  for (const id of [kept, left, demoted, paused]) await store.setSubscribed(id, true, new Date());
  const day = await freshDay(), months = lastTwelveMonths(day), co = await company("Burst Co");
  await co.place(`${ym(day)}-01`, `${ym(day)}-02`);
  await store.sendDay(day, months, new Date(`${day}T06:00:00Z`), data => firingSpikes(day, data.companies.filter(c => c.orgId === co.id), data.counts));
  await store.setSubscribed(left, false, new Date());
  await pool.query("DELETE FROM grants WHERE principal_id=$1", [demoted]);
  await pool.query("INSERT INTO account_pauses(id,principal_id,paused_by,reason,suspended_grants,suspended_stores) VALUES($1,$2,$3,'Away for now','[]','[]')", [randomUUID(), paused, creator]);
  const port = new FakeEmailPort();
  await new EmailOutboxService(new PostgresEmailOutboxStore({ pool, operatorOrgIds: [OPS] }), port, true, true).processDue(100, new Date());
  const states = Object.fromEntries((await pool.query("SELECT recipient_principal_id, state FROM email_outbox WHERE idempotency_key LIKE $1", [`staff.firing_spike:${co.id}:%`])).rows.map(r => [r.recipient_principal_id, r.state]));
  assert.deepEqual([kept, left, demoted, paused].map(id => states[id]), ["sent", "suppressed", "suppressed", "suppressed"]);
  const delivered = port.sent.filter(m => m.to === `${kept}@example.invalid`);
  assert.equal(delivered[0]?.subject, "Firing spike for Burst Co");
});

test("REPORTS_FIRING_SPIKE_PG a subscriber who switched the email off in their preferences is no recipient, so the month stays unalerted", async () => {
  const ops = `fs-ops-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: ops, name: "Operator" }));
  const own = new PostgresFiringSpikeStore({ pool, operatorOrgIds: [ops] });
  const [off, on] = [await principal("off", [{ orgId: ops, role: "staff", scope: "subtree" }]), await principal("on", [{ orgId: ops, role: "staff", scope: "subtree" }])];
  await own.setSubscribed(off, true, new Date());
  await pool.query("INSERT INTO email_preferences(principal_id, class, enabled) VALUES($1, 'staff.firing_spike', false)", [off]);
  assert.deepEqual(await own.recipients(), []);
  const orgId = `fs-co-${randomUUID()}`, month = "1999-01";
  await authz.upsertOrganization(createOrganization({ id: orgId, name: "Muted Co", parentOrgId: ops }));
  const alert = () => [{ orgId, month, parameters: { company: "Muted Co", month, level: "danger", total: 2, twelveMonthTotal: 2 } }];
  assert.deepEqual(await own.sendDay(await freshDay(), lastTwelveMonths("1999-01-15"), new Date(), alert), { alerts: 0 });
  assert.equal((await pool.query("SELECT count(*)::int n FROM firing_spike_alerts WHERE org_id = $1", [orgId])).rows[0].n, 0);
  await own.setSubscribed(on, true, new Date());
  assert.deepEqual(await own.recipients(), [on]);
  assert.deepEqual(await own.sendDay(await freshDay(), lastTwelveMonths("1999-01-15"), new Date(), alert), { alerts: 1 });
  const queued = (await pool.query("SELECT recipient_principal_id FROM email_outbox WHERE idempotency_key LIKE $1", [`staff.firing_spike:${orgId}:%`])).rows;
  assert.deepEqual(queued.map(r => r.recipient_principal_id), [on]);
  await pool.query("UPDATE email_outbox SET state='not_sent' WHERE idempotency_key LIKE $1 AND state='pending'", [`staff.firing_spike:${orgId}:%`]);
});
