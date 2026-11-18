import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAccessStaffViewsStore, PostgresAuthzStore, runMigrations } from "@studenthub/db";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, views: PostgresAccessStaffViewsStore, authz: PostgresAuthzStore;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  views = new PostgresAccessStaffViewsStore({ pool });
  authz = new PostgresAuthzStore(pool);
});
after(async () => pool.end());

async function person() {
  const id = `a9-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], displayName: `Person ${id}` }));
  return id;
}

test("A9_RECORD a view keeps both identities, the reason and a 15 minute window; it ends and is never edited", async () => {
  const [staff, target] = [await person(), await person()];
  const started = await views.start(staff, { targetPrincipalId: target, reason: "Support ticket 1234" });
  assert.equal(Date.parse(started.expiresAt) - Date.parse(started.startedAt), 900_000);
  assert.deepEqual(await views.open(staff, target), started);
  assert.equal(await views.open(target, staff), null, "the view is the staff member's, of this person");
  assert.equal(await views.open(await person(), target), null, "another staff member has no open view");
  assert.deepEqual(await views.viewedOn(target), [started.startedAt]);
  await assert.rejects(pool.query("UPDATE staff_views SET expires_at = expires_at + interval '1 hour' WHERE id = $1", [started.id]), /append-only/);
  await assert.rejects(pool.query("DELETE FROM staff_views WHERE id = $1", [started.id]), /append-only/);
  await assert.rejects(pool.query("INSERT INTO staff_views (id, staff_principal_id, target_principal_id, reason, started_at, expires_at) VALUES ($1, $2, $3, 'Longer', now(), now() + interval '1 hour')", [randomUUID(), staff, target]), /check/i);
  await assert.rejects(views.start(target, { targetPrincipalId: target, reason: "Myself" }), /check/i, "never oneself");
  // An ended view is not open.
  await pool.query("INSERT INTO staff_views (id, staff_principal_id, target_principal_id, reason, started_at, expires_at) VALUES ($1, $2, $3, 'Earlier', now() - interval '1 hour', now() - interval '45 minutes')", [randomUUID(), staff, target]);
  const other = await person();
  await pool.query("INSERT INTO staff_views (id, staff_principal_id, target_principal_id, reason, started_at, expires_at) VALUES ($1, $2, $3, 'Earlier', now() - interval '1 hour', now() - interval '45 minutes')", [randomUUID(), staff, other]);
  assert.equal(await views.open(staff, other), null);
  assert.equal((await views.viewedOn(target)).length, 2);
});
