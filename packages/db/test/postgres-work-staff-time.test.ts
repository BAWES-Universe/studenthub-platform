import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresWorkStaffTimeStore } from "@studenthub/db/work";
import { StaffTimeService } from "../../work/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresWorkStaffTimeStore;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  store = new PostgresWorkStaffTimeStore(pool);
  if (!(await pool.query("SELECT 1 FROM organizations WHERE id = 'root'")).rowCount) await authz.upsertOrganization(createOrganization({ id: "root", name: "StudentHub" }));
});
after(async () => pool.end());

async function principal(prefix: string, grants: { orgId: string; role: string; scope: "self" | "subtree" }[] = []) {
  const id = `staff-time-${prefix}-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  if (grants.length) await authz.grantMany(id, grants as never);
  return id;
}
function service(now: { value: Date }) {
  return new StaffTimeService({ store, grants: authz, newId: () => randomUUID(), now: () => now.value });
}

test("STAFF_TIME_PG start, a repeat start, end with server minutes; days and who didn't start", async () => {
  const staff = await principal("staff", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  const admin = await principal("admin", [{ orgId: "root", role: "admin", scope: "subtree" }]);
  const absent = await principal("absent", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  const now = { value: new Date("2031-05-04T05:00:00Z") };
  const svc = service(now);
  const started = await svc.start(staff);
  assert.equal(started.kind === "started" && started.session.workDate, "2031-05-04");
  const again = await svc.start(staff);
  assert.equal(again.kind === "started" && again.already, true);
  now.value = new Date("2031-05-04T07:05:59Z");
  const ended = await svc.end(staff);
  assert.equal(ended.kind === "ended" && ended.session.minutes, 125);
  assert.deepEqual(await svc.end(staff), { kind: "refused", code: "not_working" });
  await svc.start(staff);
  const days = await svc.days(admin, "2031-05-01", "2031-05-31", { staffId: staff });
  assert.deepEqual(days.kind === "days" && days.days.map((d) => [d.workDate, d.minutes, d.sessions, d.open, d.lastEnd]), [["2031-05-04", 125, 2, true, "2031-05-04T07:05:59.000Z"]]);
  const own = await svc.days(staff, "2031-05-01", "2031-05-31");
  assert.equal(own.kind === "days" && own.days.length, 1);
  const inactive = await svc.inactive(admin, "2031-05-04");
  assert.ok(inactive.kind === "inactive" && inactive.staffIds.includes(absent) && inactive.staffIds.includes(admin) && !inactive.staffIds.includes(staff));
  assert.deepEqual(await svc.start(await principal("owner")), { kind: "refused", code: "forbidden" });
  // The staff hours export reads email addresses on file.
  assert.deepEqual([...await store.emails([staff, "nobody-here"])], [[staff, `${staff}@example.invalid`]]);
});

test("STAFF_TIME_PG two parallel starts make one open session", async () => {
  const staff = await principal("race", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  const svc = service({ value: new Date("2031-05-05T05:00:00Z") });
  const [a, b] = await Promise.all([svc.start(staff), svc.start(staff)]);
  assert.equal(a.kind === "started" && b.kind === "started" && a.session.id === b.session.id, true);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM work_staff_sessions WHERE staff_principal_id = $1", [staff])).rows[0].n, 1);
});

test("STAFF_TIME_PG days are keyset-paged newest first", async () => {
  const staff = await principal("pages", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  for (const day of ["06", "07", "08"]) await store.insertOpen({ id: randomUUID(), staffId: staff, workDate: `2031-05-${day}`, startedAt: new Date(`2031-05-${day}T05:00:00Z`) });
  const range = { from: "2031-05-06", to: "2031-05-08" };
  const first = await store.days({ range, staffId: staff, limit: 2 });
  assert.deepEqual(first.map((d) => d.workDate), ["2031-05-08", "2031-05-07"]);
  const rest = await store.days({ range, staffId: staff, after: { workDate: "2031-05-07", staffId: staff }, limit: 2 });
  assert.deepEqual(rest.map((d) => d.workDate), ["2031-05-06"]);
});

test("STAFF_TIME_PG the table: an end is written once, a closed session is never edited, nothing is removed", async () => {
  const staff = await principal("table", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  const id = randomUUID();
  await store.insertOpen({ id, staffId: staff, workDate: "2031-05-09", startedAt: new Date("2031-05-09T05:00:00Z") });
  // A clock that stepped back ends at the start: zero minutes, never negative.
  const ended = await store.end(id, new Date("2031-05-09T04:00:00Z"));
  assert.equal(ended?.minutes, 0);
  assert.equal(await store.end(id, new Date("2031-05-09T09:00:00Z")), undefined);
  await assert.rejects(pool.query("UPDATE work_staff_sessions SET ended_at = ended_at + interval '1 hour' WHERE id = $1", [id]), /never edited/);
  await assert.rejects(pool.query("UPDATE work_staff_sessions SET started_at = started_at - interval '1 hour' WHERE id = $1", [id]), /only the end is written/);
  await assert.rejects(pool.query("DELETE FROM work_staff_sessions WHERE id = $1", [id]), /never removed/);
  await assert.rejects(pool.query("INSERT INTO work_staff_sessions(id, staff_principal_id, work_date, started_at, ended_at, source) VALUES($1,$2,'2031-05-10','2031-05-10T05:00:00Z','2031-05-10T04:00:00Z','timer')",
    [randomUUID(), staff]), /ends before it starts/);
  await assert.rejects(pool.query("INSERT INTO work_staff_sessions(id, staff_principal_id, work_date, started_at, source) VALUES($1,$2,'2031-05-10','2031-05-10T05:00:00Z','import')",
    [randomUUID(), staff]), /check/i, "an import row needs its legacy reference");
});
