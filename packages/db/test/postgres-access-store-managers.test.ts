import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal, resolveActiveContext } from "@studenthub/contracts";
import { PostgresAccessInvitationsStore, PostgresAccessStoreManagersStore, PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { createCompanyTeamService, managedStores, openManagedStore, recordingInvitationMailer, type CompanyTeamService } from "../../access/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
const ORIGIN = "https://hub.example";
const REF = "a".repeat(64);
let pool: pg.Pool, authz: PostgresAuthzStore, stores: PostgresAccessStoreManagersStore, team: CompanyTeamService;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  stores = new PostgresAccessStoreManagersStore({ pool });
  team = createCompanyTeamService({ store: new PostgresAccessInvitationsStore({ pool }), mailer: recordingInvitationMailer() });
});
after(async () => pool.end());

async function company(name = "Acme", parentOrgId?: string) {
  const id = `a4-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id, name: `${name} ${id}`, ...(parentOrgId ? { parentOrgId } : {}) }));
  return id;
}
async function store(orgId: string, name: string) {
  const id = randomUUID();
  await pool.query("INSERT INTO organization_stores (id, org_id, name, location, created_by_ref, updated_by_ref) VALUES ($1, $2, $3, 'Hall 2', $4, $4)", [id, orgId, name, REF]);
  return id;
}
async function person(grants: { orgId: string; role: string; scope?: "self" | "subtree" }[] = [], email = `a4-${randomUUID()}@example.com`) {
  const id = `a4-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], displayName: `Person ${id}`, email }));
  if (grants.length) await authz.grantMany(id, grants);
  return { id, email };
}
async function makeManager(owner: string, orgId: string, storeId: string, who?: { id: string; email: string }) {
  const manager = who ?? await person();
  const invited = await team.invite(owner, orgId, { email: manager.email, role: "store-manager", scope: "self", storeId }, ORIGIN);
  if (invited.kind !== "invited") throw new Error(JSON.stringify(invited));
  const accepted = await team.accept(invited.link.split("/invitations/")[1]!, manager.id);
  assert.equal(accepted.kind, "accepted");
  return manager;
}
const ids = async (principalId: string) => managedStores(principalId, await stores.rows(principalId)).map((row) => row.storeId);

test("A4_GRANT an accepted store invitation writes a store grant row and a store event, never a grants row", async () => {
  const acme = await company();
  const avenues = await store(acme, "Avenues");
  const owner = await person([{ orgId: acme, role: "org-owner" }]);
  const manager = await makeManager(owner.id, acme, avenues);
  assert.deepEqual(await ids(manager.id), [avenues]);
  assert.deepEqual(await stores.managedStores(manager.id), [{ orgId: acme, storeId: avenues }]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM grants WHERE principal_id = $1", [manager.id])).rows[0].n, 0);
  assert.deepEqual((await pool.query("SELECT role, scope, action, actor_principal_id, store_id FROM access_grant_events WHERE target_principal_id = $1", [manager.id])).rows,
    [{ role: "store-manager", scope: "store", action: "grant", actor_principal_id: owner.id, store_id: avenues }]);
  // Refusals: another company's store, a removed store, a recruiter offering.
  const beta = await company("Beta");
  const betaStore = await store(beta, "Beta store");
  assert.deepEqual(await team.invite(owner.id, acme, { email: "x@example.com", role: "store-manager", scope: "self", storeId: betaStore }, ORIGIN), { kind: "refused", reason: "unknown_store" });
  const closed = await store(acme, "Closed");
  await pool.query("UPDATE organization_stores SET status = 'deleted', deleted_at = clock_timestamp() WHERE id = $1", [closed]);
  assert.deepEqual(await team.invite(owner.id, acme, { email: "x@example.com", role: "store-manager", scope: "self", storeId: closed }, ORIGIN), { kind: "refused", reason: "unknown_store" });
  const recruiter = await person([{ orgId: acme, role: "recruiter" }]);
  assert.deepEqual(await team.invite(recruiter.id, acme, { email: "x@example.com", role: "store-manager", scope: "self", storeId: avenues }, ORIGIN), { kind: "refused", reason: "not_owner" });
  // A store removed between invitation and acceptance: the link is dead.
  const later = await store(acme, "Later");
  const someone = await person();
  const invited = await team.invite(owner.id, acme, { email: someone.email, role: "store-manager", scope: "self", storeId: later }, ORIGIN);
  if (invited.kind !== "invited") throw new Error("expected an invitation");
  await pool.query("UPDATE organization_stores SET status = 'deleted', deleted_at = clock_timestamp() WHERE id = $1", [later]);
  assert.deepEqual(await team.accept(invited.link.split("/invitations/")[1]!, someone.id), { kind: "invalid" });
  assert.deepEqual(await ids(someone.id), []);
});

test("A4_NO_LEAK a manager reads only their store: not a sibling store, not a sub-company's store", async () => {
  const acme = await company();
  const sub = await company("Sub", acme);
  const [avenues, marina, subStore] = [await store(acme, "Avenues"), await store(acme, "Marina"), await store(sub, "Sub store")];
  const owner = await person([{ orgId: acme, role: "org-owner", scope: "subtree" }]);
  const manager = await makeManager(owner.id, acme, avenues);
  const rows = await stores.rows(manager.id);
  assert.equal(openManagedStore(manager.id, avenues, rows)?.name, "Avenues");
  assert.equal(openManagedStore(manager.id, marina, rows), undefined);
  assert.equal(openManagedStore(manager.id, subStore, rows), undefined);
  assert.deepEqual(rows.map((row) => row.storeId), [avenues], "one query returns only the person's own grant rows");
  // Read at request time: a renamed store shows its new name.
  await pool.query("UPDATE organization_stores SET name = 'Avenues Mall' WHERE id = $1", [avenues]);
  assert.equal(openManagedStore(manager.id, avenues, await stores.rows(manager.id))?.name, "Avenues Mall");
  const view = await team.team(owner.id, acme);
  assert.deepEqual(view?.storeManagers.map((row) => [row.principalId, row.storeName]), [[manager.id, "Avenues Mall"]]);
});

test("A4_INDEPENDENT a store grant and a company grant never satisfy each other", async () => {
  const acme = await company();
  const beta = await company("Beta");
  const [acmeStore, betaStore] = [await store(acme, "Acme store"), await store(beta, "Beta store")];
  const owner = await person([{ orgId: acme, role: "org-owner" }]);
  const both = await person([{ orgId: beta, role: "recruiter" }]);
  await makeManager(owner.id, acme, acmeStore, both);
  // Someone else manages a Beta store: the recruiter grant at Beta must not reach it.
  const betaOwner = await person([{ orgId: beta, role: "org-owner" }]);
  await makeManager(betaOwner.id, beta, betaStore);
  assert.equal((await resolveActiveContext({ kind: "principal", principalId: both.id }, { orgId: acme, role: "recruiter" }, authz)).kind, "denied", "the store grant opens no company context");
  assert.equal((await resolveActiveContext({ kind: "principal", principalId: both.id }, { orgId: beta, role: "recruiter" }, authz)).kind, "authorized");
  assert.deepEqual(await ids(both.id), [acmeStore], "the recruiter grant at Beta opens no Beta store");
  assert.deepEqual(await stores.managedStores(both.id), [{ orgId: acme, storeId: acmeStore }]);
  assert.equal(await team.team(both.id, acme), null, "the Team page of Acme stays closed");
});

test("A4_REVOKE removal, a removed store and a deleted company end the grant on the next read without deleting rows", async () => {
  const acme = await company();
  const [one, two] = [await store(acme, "One"), await store(acme, "Two")];
  const owner = await person([{ orgId: acme, role: "org-owner" }]);
  const manager = await makeManager(owner.id, acme, one);
  await makeManager(owner.id, acme, two, manager);
  assert.deepEqual((await ids(manager.id)).sort(), [one, two].sort());
  const recruiter = await person([{ orgId: acme, role: "recruiter" }]);
  assert.deepEqual(await team.removeStoreManager(recruiter.id, acme, one, manager.id), { kind: "refused", reason: "not_allowed" });
  assert.deepEqual(await team.removeStoreManager(owner.id, acme, one, manager.id), { kind: "removed" });
  assert.deepEqual(await ids(manager.id), [two]);
  assert.deepEqual(await team.removeStoreManager(owner.id, acme, one, manager.id), { kind: "refused", reason: "not_found" });
  const events = (await pool.query("SELECT action, scope, store_id, actor_principal_id, reason FROM access_grant_events WHERE target_principal_id = $1 ORDER BY id", [manager.id])).rows;
  assert.deepEqual(events.at(-1), { action: "revoke", scope: "store", store_id: one, actor_principal_id: owner.id, reason: "Store manager access removed" });
  await pool.query("UPDATE organization_stores SET status = 'deleted', deleted_at = clock_timestamp() WHERE id = $1", [two]);
  assert.deepEqual(await ids(manager.id), []);
  assert.deepEqual(await stores.managedStores(manager.id), []);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM store_manager_access WHERE principal_id = $1", [manager.id])).rows[0].n, 2, "rows stay");
  // A deleted company ends a live grant on a live store.
  const beta = await company("Beta");
  const betaStore = await store(beta, "Beta store");
  const betaOwner = await person([{ orgId: beta, role: "org-owner" }]);
  await makeManager(betaOwner.id, beta, betaStore, manager);
  assert.deepEqual(await ids(manager.id), [betaStore]);
  await pool.query("INSERT INTO organization_deletions (org_id, receipt_ref) VALUES ($1, $2)", [beta, randomUUID().replaceAll("-", "").padEnd(64, "0")]);
  assert.deepEqual(await ids(manager.id), []);
  assert.deepEqual(await stores.managedStores(manager.id), []);
  await assert.rejects(pool.query("DELETE FROM store_manager_access WHERE principal_id = $1", [manager.id]), /never deleted/);
});
