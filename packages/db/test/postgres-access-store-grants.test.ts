import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAccessGrantsStore, PostgresAccessStoreManagersStore, PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { createStoreGrantService, decideStoreGrant, type StoreGrantRequest } from "../../access/src/index.js";

// Access lane G-02: store manager access given or taken away on the Access pages.

const URL = process.env.DATABASE_URL ?? "";
const SECRET = Buffer.alloc(32, 11);
const REF = "a".repeat(64);
let pool: pg.Pool, authz: PostgresAuthzStore, grants: PostgresAccessGrantsStore, managers: PostgresAccessStoreManagersStore;
let root: string;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  grants = new PostgresAccessGrantsStore({ pool });
  managers = new PostgresAccessStoreManagersStore({ pool });
  root = `g02s-root-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: root, name: `Operator ${root}` }));
});
after(async () => pool.end());

async function company(name = "Acme", parentOrgId = root) {
  const id = `g02s-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id, name: `${name} ${id}`, parentOrgId }));
  return id;
}
async function shop(orgId: string, name: string) {
  const id = randomUUID();
  await pool.query("INSERT INTO organization_stores (id, org_id, name, location, created_by_ref, updated_by_ref) VALUES ($1, $2, $3, 'Hall 2', $4, $4)", [id, orgId, name, REF]);
  return id;
}
async function person(held: { orgId: string; role: string; scope?: "self" | "subtree" }[] = []) {
  const id = `g02s-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], displayName: `Person ${id}`, email: `${id}@example.invalid` }));
  if (held.length) await authz.grantMany(id, held);
  return id;
}
const writes = () => createStoreGrantService({ store: grants, secret: SECRET, operatorOrgIds: [root] });
const change = (over: Partial<StoreGrantRequest> & Pick<StoreGrantRequest, "targetPrincipalId" | "storeId">): StoreGrantRequest =>
  ({ action: "grant", reason: "Runs the Salmiya branch", ...over });
async function events(target: string) {
  return (await pool.query("SELECT org_id, role, scope, action, actor_principal_id, reason, store_id, token_id FROM access_grant_events WHERE target_principal_id = $1 ORDER BY id", [target])).rows;
}
async function rows(target: string) {
  return (await pool.query("SELECT store_id, granted_by, revoked_by, revoked_at IS NOT NULL AS revoked FROM store_manager_access WHERE principal_id = $1 ORDER BY created_at", [target])).rows;
}

test("G02_STORE_ATOMIC one confirm writes the store access and its event; the store pages see it; revoke ends it", async () => {
  const acme = await company("Acme");
  const salmiya = await shop(acme, "Salmiya");
  const staff = await person([{ orgId: root, role: "staff", scope: "subtree" }]);
  const target = await person();
  const request = change({ targetPrincipalId: target, storeId: salmiya });
  const preview = await writes().preview(staff, request);
  if (!preview.ok || preview.kind !== "change") throw new Error(`expected a change: ${JSON.stringify(preview)}`);
  assert.equal(preview.store.orgId, acme);
  assert.deepEqual(await rows(target), [], "a preview writes nothing");
  assert.deepEqual(await events(target), []);
  assert.deepEqual(await writes().confirm(staff, request, preview.token), { kind: "applied", before: false, after: true });
  assert.deepEqual(await rows(target), [{ store_id: salmiya, granted_by: staff, revoked_by: null, revoked: false }]);
  assert.deepEqual(await events(target), [{ org_id: acme, role: "store-manager", scope: "store", action: "grant", actor_principal_id: staff, reason: "Runs the Salmiya branch", store_id: salmiya, token_id: preview.token.tokenId }]);
  // The A4 store pages read the same row on the next request.
  assert.deepEqual(await managers.managedStores(target), [{ orgId: acme, storeId: salmiya }]);
  assert.deepEqual((await grants.storeGrants(target)).map((item) => item.storeId), [salmiya]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM grants WHERE principal_id = $1", [target])).rows[0].n, 0, "no role and no scope is added");

  const revoke = change({ targetPrincipalId: target, storeId: salmiya, action: "revoke", reason: "Moved to Hawally" });
  const review = await writes().preview(staff, revoke);
  if (!review.ok || review.kind !== "change") throw new Error("expected a change");
  assert.deepEqual(await writes().confirm(staff, revoke, review.token), { kind: "applied", before: true, after: false });
  assert.deepEqual(await rows(target), [{ store_id: salmiya, granted_by: staff, revoked_by: staff, revoked: true }], "the row stays, with revoked_at");
  assert.deepEqual(await managers.managedStores(target), []);
  assert.deepEqual((await events(target)).map((row) => [row.action, row.reason]), [["grant", "Runs the Salmiya branch"], ["revoke", "Moved to Hawally"]]);
  // Replaying the first token is refused and changes nothing.
  assert.deepEqual(await writes().confirm(staff, request, preview.token), { kind: "refused", reason: "token_already_used" });
  assert.equal((await events(target)).length, 2);
  assert.deepEqual(await managers.managedStores(target), []);
});

test("G02_STORE_ATOMIC a failure of the event write rolls back the store access", async () => {
  const acme = await company("Acme");
  const salmiya = await shop(acme, "Salmiya");
  const admin = await person([{ orgId: root, role: "admin", scope: "subtree" }]);
  const target = await person();
  // A one-character reason passes the decision but fails the events CHECK, which runs last.
  const request = change({ targetPrincipalId: target, storeId: salmiya, reason: "x" });
  await assert.rejects(grants.applyStore({ callerId: admin, request, tokenId: "f".repeat(64), expectedHeld: false,
    decide: (snapshot) => decideStoreGrant(admin, request, snapshot, [root]), expiresAt: Date.now() + 60_000, now: () => Date.now() }),
  { code: "23514", table: "access_grant_events" });
  assert.deepEqual(await rows(target), []);
  assert.deepEqual(await events(target), []);
});

test("G02_STORE_GUARDS the caller's right, the store and the pause are read again inside the confirm", async () => {
  const acme = await company("Acme");
  const salmiya = await shop(acme, "Salmiya");
  const hawally = await shop(acme, "Hawally");
  const staff = await person([{ orgId: root, role: "staff", scope: "subtree" }]);
  // An owner of the company who can't open the Access pages uses the team page instead.
  const owner = await person([{ orgId: acme, role: "org-owner", scope: "self" }]);
  const target = await person();
  assert.deepEqual(await writes().preview(owner, change({ targetPrincipalId: target, storeId: salmiya })), { ok: false, reason: "not_allowed" });

  // The right is taken away between preview and confirm.
  const lapsed = await person([{ orgId: root, role: "staff", scope: "subtree" }]);
  const first = await writes().preview(lapsed, change({ targetPrincipalId: target, storeId: salmiya }));
  if (!first.ok || first.kind !== "change") throw new Error("expected a change");
  await pool.query("DELETE FROM grants WHERE principal_id = $1", [lapsed]);
  assert.deepEqual(await writes().confirm(lapsed, change({ targetPrincipalId: target, storeId: salmiya }), first.token), { kind: "refused", reason: "not_allowed" });

  // The store is removed between preview and confirm.
  const second = await writes().preview(staff, change({ targetPrincipalId: target, storeId: hawally }));
  if (!second.ok || second.kind !== "change") throw new Error("expected a change");
  await pool.query("UPDATE organization_stores SET status = 'deleted', deleted_at = clock_timestamp() WHERE id = $1", [hawally]);
  assert.deepEqual(await writes().confirm(staff, change({ targetPrincipalId: target, storeId: hawally }), second.token), { kind: "refused", reason: "unknown_store" });

  // The person is paused between preview and confirm.
  const third = await writes().preview(staff, change({ targetPrincipalId: target, storeId: salmiya }));
  if (!third.ok || third.kind !== "change") throw new Error("expected a change");
  await pool.query("INSERT INTO account_pauses (id, principal_id, paused_by, reason, suspended_grants, suspended_stores) VALUES ($1, $2, $3, 'Reported misuse', '[]', '[]')",
    [randomUUID(), target, staff]);
  assert.deepEqual(await writes().confirm(staff, change({ targetPrincipalId: target, storeId: salmiya }), third.token), { kind: "refused", reason: "paused" });
  assert.deepEqual(await writes().preview(staff, change({ targetPrincipalId: target, storeId: salmiya })), { ok: false, reason: "paused" });

  assert.deepEqual(await rows(target), []);
  assert.deepEqual(await events(target), []);
});

test("G02_STORE_GUARDS a change made on the team page meanwhile is state_changed, and one token applies once under concurrency", async () => {
  const acme = await company("Acme");
  const salmiya = await shop(acme, "Salmiya");
  const staff = await person([{ orgId: root, role: "staff", scope: "subtree" }]);
  const target = await person();
  const request = change({ targetPrincipalId: target, storeId: salmiya });
  const preview = await writes().preview(staff, request);
  if (!preview.ok || preview.kind !== "change") throw new Error("expected a change");
  await pool.query("INSERT INTO store_manager_access (id, org_id, store_id, principal_id, granted_by) VALUES ($1, $2, $3, $4, $5)", [randomUUID(), acme, salmiya, target, staff]);
  assert.deepEqual(await writes().confirm(staff, request, preview.token), { kind: "refused", reason: "state_changed" });
  assert.deepEqual(await events(target), []);

  const other = await person();
  const twice = change({ targetPrincipalId: other, storeId: salmiya });
  const review = await writes().preview(staff, twice);
  if (!review.ok || review.kind !== "change") throw new Error("expected a change");
  const outcomes = await Promise.all([writes().confirm(staff, twice, review.token), writes().confirm(staff, twice, review.token)]);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), ["applied", "refused"]);
  assert.ok(outcomes.some((outcome) => outcome.kind === "refused" && outcome.reason === "token_already_used"), JSON.stringify(outcomes));
  assert.equal((await rows(other)).length, 1);
  assert.equal((await events(other)).length, 1);
});

test("G02_STORE_LIST store search finds active stores of live companies by name prefix; a person's list drops removed stores", async () => {
  const tag = `Zq${randomUUID().slice(0, 8)}`;
  const acme = await company("Acme");
  const gone = await company("Gone");
  const open = await shop(acme, `${tag} Salmiya`);
  const removed = await shop(acme, `${tag} Hawally`);
  const deletedCompany = await shop(gone, `${tag} Jabriya`);
  const wild = await shop(acme, `${tag}%wild`);
  await pool.query("UPDATE organization_stores SET status = 'deleted', deleted_at = clock_timestamp() WHERE id = $1", [removed]);
  await pool.query("INSERT INTO organization_deletions (org_id, receipt_ref) VALUES ($1, $2)", [gone, randomUUID().replaceAll("-", "").padEnd(64, "0")]);
  const found = await grants.findStores(`  ${tag.toLowerCase()} `);
  assert.deepEqual(found.map((item) => item.storeId).sort(), [open, wild].sort(), "trimmed, any case; a removed store and a deleted company's store are left out");
  assert.ok(found.every((item) => item.orgId === acme));
  assert.ok(!found.some((item) => item.storeId === deletedCompany || item.storeId === removed));
  assert.deepEqual((await grants.findStores(`${tag}%`)).map((item) => item.name), [`${tag}%wild`], "% matches itself, not anything");

  const staff = await person([{ orgId: root, role: "staff", scope: "subtree" }]);
  const target = await person();
  const later = await shop(acme, `${tag} Later`);
  for (const storeId of [open, later]) {
    await pool.query("INSERT INTO store_manager_access (id, org_id, store_id, principal_id, granted_by) VALUES ($1, $2, $3, $4, $5)", [randomUUID(), acme, storeId, target, staff]);
  }
  await pool.query("UPDATE organization_stores SET status = 'deleted', deleted_at = clock_timestamp() WHERE id = $1", [later]);
  assert.deepEqual((await grants.storeGrants(target)).map((item) => item.storeId), [open]);
});
