import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAccessPausesStore, PostgresAuthzStore, PostgresLoginStore, runMigrations } from "@studenthub/db";
import { createAccountPauseService, type AccountPauseService } from "../../access/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
const REF = "a".repeat(64);
let pool: pg.Pool, authz: PostgresAuthzStore, pauses: PostgresAccessPausesStore, login: PostgresLoginStore, service: AccountPauseService;
const ROOT = `a6-root-${randomUUID()}`;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  pauses = new PostgresAccessPausesStore({ pool });
  login = new PostgresLoginStore(pool);
  service = createAccountPauseService({ store: pauses, operatorOrgIds: [ROOT] });
  await authz.upsertOrganization(createOrganization({ id: ROOT, name: `Root ${ROOT}` }));
});
after(async () => pool.end());

async function company(name = "Acme") {
  const id = `a6-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id, name: `${name} ${id}` }));
  return id;
}
async function store(orgId: string) {
  const id = randomUUID();
  await pool.query("INSERT INTO organization_stores (id, org_id, name, location, created_by_ref, updated_by_ref) VALUES ($1, $2, 'Avenues', 'Hall 2', $3, $3)", [id, orgId, REF]);
  return id;
}
async function person(grants: { orgId: string; role: string; scope?: "self" | "subtree" }[] = [], email = `a6-${randomUUID()}@example.com`) {
  const id = `a6-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], displayName: `Person ${id}`, email }));
  if (grants.length) await authz.grantMany(id, grants);
  return id;
}
const reason = "Reported for misuse of the platform";
const held = async (id: string) => (await pool.query("SELECT org_id, role, scope FROM grants WHERE principal_id = $1 ORDER BY org_id, role", [id])).rows;
const liveStores = async (id: string) => (await pool.query("SELECT store_id FROM store_manager_access WHERE principal_id = $1 AND revoked_at IS NULL", [id])).rows.map((row) => row.store_id);
const sessions = async (id: string) => (await pool.query("SELECT count(*)::int AS n FROM login_sessions WHERE person_id = $1", [id])).rows[0].n;

test("A6_PAUSE pausing takes every grant and store grant away, ends sessions and refuses new ones, with audit and events", async () => {
  const acme = await company();
  const shop = await store(acme);
  const staff = await person([{ orgId: ROOT, role: "staff", scope: "subtree" }]);
  const target = await person([{ orgId: acme, role: "recruiter" }, { orgId: acme, role: "finance" }]);
  await pool.query("INSERT INTO store_manager_access (id, org_id, store_id, principal_id, granted_by) VALUES ($1, $2, $3, $4, $5)", [randomUUID(), acme, shop, target, staff]);
  await login.sessions.put({ id: randomUUID(), personId: target });
  await login.sessions.put({ id: randomUUID(), personId: target });
  assert.deepEqual(await service.change(staff, { targetPrincipalId: target, action: "pause", reason }), { kind: "paused", grants: 2, storeGrants: 1 });
  assert.deepEqual(await held(target), []);
  assert.deepEqual(await liveStores(target), []);
  assert.equal(await sessions(target), 0, "existing sessions end on the next request");
  await assert.rejects(login.sessions.put({ id: randomUUID(), personId: target }), /access is paused/, "no new session while paused");
  assert.deepEqual((await pauses.paused([target, staff])), new Set([target]));
  const live = await pauses.pause(target);
  assert.equal(live?.reason, reason);
  assert.equal(live?.pausedBy.principalId, staff);
  assert.equal(live?.grants.length, 2);
  const events = (await pool.query("SELECT role, scope, action, actor_principal_id, reason, store_id FROM access_grant_events WHERE target_principal_id = $1 ORDER BY role", [target])).rows;
  assert.deepEqual(events.map((row) => [row.role, row.action, row.actor_principal_id, row.reason]), [
    ["finance", "revoke", staff, `Access paused: ${reason}`], ["recruiter", "revoke", staff, `Access paused: ${reason}`], ["store-manager", "revoke", staff, `Access paused: ${reason}`]]);
  const audit = (await pool.query("SELECT count(*)::int AS n FROM authorization_mutation_audit WHERE operation = 'grants.revoke' AND target_principal_ref = (SELECT target_principal_ref FROM authorization_mutation_audit ORDER BY id DESC LIMIT 1)")).rows[0].n;
  assert.ok(audit >= 1, "the revoke is audited");
  assert.deepEqual(await service.change(staff, { targetPrincipalId: target, action: "pause", reason }), { kind: "refused", reason: "already_paused" });
  await assert.rejects(pool.query("DELETE FROM account_pauses WHERE principal_id = $1", [target]), /never deleted/);
});

test("A6_RESUME resuming gives back what can still be given, once, and sign-in works again", async () => {
  const [acme, gone] = [await company(), await company("Gone")];
  const [shop, closed] = [await store(acme), await store(acme)];
  const admin = await person([{ orgId: ROOT, role: "admin", scope: "subtree" }]);
  const target = await person([{ orgId: acme, role: "org-owner" }, { orgId: gone, role: "recruiter" }]);
  for (const storeId of [shop, closed]) {
    await pool.query("INSERT INTO store_manager_access (id, org_id, store_id, principal_id, granted_by) VALUES ($1, $2, $3, $4, $5)", [randomUUID(), acme, storeId, target, admin]);
  }
  assert.equal((await service.change(admin, { targetPrincipalId: target, action: "pause", reason })).kind, "paused");
  await pool.query("INSERT INTO organization_deletions (org_id, receipt_ref) VALUES ($1, $2)", [gone, randomUUID().replaceAll("-", "").padEnd(64, "0")]);
  await pool.query("UPDATE organization_stores SET status = 'deleted', deleted_at = clock_timestamp() WHERE id = $1", [closed]);
  assert.deepEqual(await service.change(admin, { targetPrincipalId: target, action: "resume", reason: "Cleared after review" }), { kind: "resumed", restored: 2, leftOut: 2 });
  assert.deepEqual(await held(target), [{ org_id: acme, role: "org-owner", scope: "self" }]);
  assert.deepEqual(await liveStores(target), [shop]);
  await login.sessions.put({ id: randomUUID(), personId: target });
  assert.equal(await sessions(target), 1);
  assert.equal(await pauses.pause(target), null);
  assert.deepEqual(await service.change(admin, { targetPrincipalId: target, action: "resume", reason: "Cleared after review" }), { kind: "refused", reason: "not_paused" });
  await assert.rejects(pool.query("UPDATE account_pauses SET resume_reason = 'again' WHERE principal_id = $1", [target]), /only be resumed, once/);
  // A second pause and resume works from the new state.
  assert.equal((await service.change(admin, { targetPrincipalId: target, action: "pause", reason })).kind, "paused");
  assert.equal((await service.change(admin, { targetPrincipalId: target, action: "resume", reason: "Cleared again" })).kind, "resumed");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM account_pauses WHERE principal_id = $1", [target])).rows[0].n, 2, "rows stay");
});

test("A6_RULES staff cannot pause staff, nobody pauses themselves, and concurrent pauses store one", async () => {
  const staff = await person([{ orgId: ROOT, role: "staff", scope: "subtree" }]);
  const otherStaff = await person([{ orgId: ROOT, role: "staff", scope: "subtree" }]);
  const admin = await person([{ orgId: ROOT, role: "admin", scope: "subtree" }]);
  assert.deepEqual(await service.change(staff, { targetPrincipalId: otherStaff, action: "pause", reason }), { kind: "refused", reason: "not_allowed" });
  assert.deepEqual(await service.change(staff, { targetPrincipalId: staff, action: "pause", reason }), { kind: "refused", reason: "self_change" });
  assert.deepEqual(await held(otherStaff), [{ org_id: ROOT, role: "staff", scope: "subtree" }]);
  const target = await person([{ orgId: await company(), role: "recruiter" }]);
  const results = await Promise.all([1, 2, 3].map(() => service.change(admin, { targetPrincipalId: target, action: "pause", reason })));
  assert.deepEqual(results.map((result) => result.kind).sort(), ["paused", "refused", "refused"]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM account_pauses WHERE principal_id = $1", [target])).rows[0].n, 1);
});

test("A6_IDENTITY an email address reused by another identity inherits nothing from a paused person", async () => {
  const admin = await person([{ orgId: ROOT, role: "admin", scope: "subtree" }]);
  const email = `a6-reuse-${randomUUID()}@example.com`;
  const first = await person([{ orgId: await company(), role: "recruiter" }], email);
  assert.equal((await service.change(admin, { targetPrincipalId: first, action: "pause", reason })).kind, "paused");
  const second = await person([], email);
  assert.deepEqual(await held(second), []);
  assert.deepEqual(await pauses.paused([second]), new Set());
  await login.sessions.put({ id: randomUUID(), personId: second });
  assert.equal(await sessions(second), 1, "the pause is keyed by principal, not by email");
});
