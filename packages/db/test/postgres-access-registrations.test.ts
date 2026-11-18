import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAccessRegistrationsStore, PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { createCompanyRegistrationService, type CompanyRegistrationService } from "../../access/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresAccessRegistrationsStore, service: CompanyRegistrationService;
const ROOT = `a7-root-${randomUUID()}`;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  store = new PostgresAccessRegistrationsStore({ pool });
  service = createCompanyRegistrationService({ store, operatorOrgIds: [ROOT] });
  await authz.upsertOrganization(createOrganization({ id: ROOT, name: `Root ${ROOT}` }));
});
after(async () => pool.end());

async function person(grants: { orgId: string; role: string; scope?: "self" | "subtree" }[] = []) {
  const id = `a7-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], displayName: `Person ${id}`, email: `${id}@example.com` }));
  if (grants.length) await authz.grantMany(id, grants);
  return id;
}
const form = (companyName = `Acme ${randomUUID().slice(0, 8)}`) => ({ companyName, contactName: "Sara Ali", contactPosition: "HR manager", phoneNumber: "+965 2222 3333", companyEmail: "hr@acme.example", requestingFor: "Weekend retail staff" });
const submit = async (who: string, companyName?: string) => {
  const outcome = await store.submit(who, form(companyName));
  assert.equal(outcome.kind, "submitted");
  return (outcome as { id: string }).id;
};
const reason = "Licence and contact checked";

test("A7_APPROVE approval creates the company active and approved to hire, and makes the submitter its owner, in one transaction", async () => {
  const staff = await person([{ orgId: ROOT, role: "staff", scope: "subtree" }]);
  const owner = await person();
  const id = await submit(owner);
  assert.deepEqual(await store.submit(owner, form()), { kind: "refused", reason: "already_pending" }, "one pending registration per person");
  assert.deepEqual(await store.submit("nobody", form()), { kind: "refused", reason: "unknown_person" });
  assert.equal((await store.queue()).pending.filter((row) => row.id === id).length, 1);
  const outcome = await service.review(staff, { registrationId: id, action: "approve", reason });
  assert.equal(outcome.kind, "approved");
  const orgId = (outcome as { orgId: string }).orgId;
  const org = (await pool.query("SELECT name, parent_org_id FROM organizations WHERE id = $1", [orgId])).rows[0];
  assert.equal(org.parent_org_id, ROOT);
  assert.match(org.name, /^Acme /);
  assert.deepEqual((await pool.query("SELECT status FROM organization_status_overrides WHERE org_id = $1", [orgId])).rows, [{ status: "active" }]);
  assert.equal((await pool.query("SELECT to_status FROM organization_status_events WHERE org_id = $1", [orgId])).rows[0].to_status, "active");
  assert.equal((await pool.query("SELECT approved FROM organization_approved_to_hire WHERE org_id = $1", [orgId])).rows[0].approved, true);
  assert.deepEqual((await pool.query("SELECT org_id, role, scope FROM grants WHERE principal_id = $1", [owner])).rows, [{ org_id: orgId, role: "org-owner", scope: "self" }]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM access_grant_events WHERE target_principal_id = $1 AND org_id = $2 AND actor_principal_id = $3 AND action = 'grant'", [owner, orgId, staff])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM authorization_mutation_audit WHERE operation IN ('organization.create', 'grants.grant') AND $1 = ANY(target_org_refs)", [(await import("@studenthub/db")).organizationAuditRef(orgId)])).rows[0].n, 2);
  const [mine] = await store.mine(owner);
  assert.equal(mine!.status, "approved");
  assert.equal(mine!.orgId, orgId);
  assert.deepEqual(await service.review(staff, { registrationId: id, action: "reject", reason }), { kind: "refused", reason: "already_decided" });
  await assert.rejects(pool.query("UPDATE company_registrations SET company_name = 'Other' WHERE id = $1", [id]), /decided once/);
  await assert.rejects(pool.query("DELETE FROM company_registrations WHERE id = $1", [id]), /kept/);
  // A failure at the owner's grant rolls the company, its status and its audit back.
  const second = await person();
  const failing = await submit(second);
  await pool.query("CREATE OR REPLACE FUNCTION a7_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'a7 forced failure'; END; $$");
  // Only this person's grant fails, so parallel suites are untouched.
  await pool.query(`CREATE TRIGGER a7_fail BEFORE INSERT ON grants FOR EACH ROW WHEN (NEW.principal_id = '${second}') EXECUTE FUNCTION a7_fail()`);
  try {
    await assert.rejects(service.review(staff, { registrationId: failing, action: "approve", reason }), /a7 forced failure/);
  } finally {
    await pool.query("DROP TRIGGER a7_fail ON grants");
  }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM grants WHERE principal_id = $1", [second])).rows[0].n, 0);
  assert.equal((await store.mine(second))[0]!.status, "pending");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM organizations WHERE parent_org_id = $1 AND name = $2", [ROOT, (await store.mine(second))[0]!.companyName])).rows[0].n, 0);
});

test("A7_REVIEW rejection keeps the reason for the person; staff never decide their own; a taken name and a paused person are refused", async () => {
  const staff = await person([{ orgId: ROOT, role: "staff", scope: "subtree" }]);
  const owner = await person();
  const id = await submit(owner);
  assert.deepEqual(await service.review(owner, { registrationId: id, action: "approve", reason }), { kind: "refused", reason: "not_allowed" });
  assert.deepEqual(await service.review(staff, { registrationId: randomUUID(), action: "approve", reason }), { kind: "refused", reason: "unknown_registration" });
  assert.deepEqual(await service.review(staff, { registrationId: id, action: "reject", reason: "We could not reach you" }), { kind: "rejected" });
  const [mine] = await store.mine(owner);
  assert.equal(mine!.status, "rejected");
  assert.equal(mine!.reviewReason, "We could not reach you");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM grants WHERE principal_id = $1", [owner])).rows[0].n, 0);
  // Staff may register a company, but another member of staff decides it.
  const own = await submit(staff);
  assert.deepEqual(await service.review(staff, { registrationId: own, action: "approve", reason }), { kind: "refused", reason: "own_registration" });
  // A taken name (any case) is refused; the registration stays pending.
  const name = `Taken ${randomUUID().slice(0, 8)}`;
  await authz.upsertOrganization(createOrganization({ id: `a7-org-${randomUUID()}`, name, parentOrgId: ROOT }));
  const clash = await submit(await person(), name.toUpperCase());
  assert.deepEqual(await service.review(staff, { registrationId: clash, action: "approve", reason }), { kind: "refused", reason: "name_taken" });
  // A paused person is never made an owner.
  const paused = await person();
  const pausedId = await submit(paused);
  await pool.query("INSERT INTO account_pauses (id, principal_id, paused_by, reason, suspended_grants, suspended_stores) VALUES ($1, $2, $3, 'Misuse reported', '[]', '[]')", [randomUUID(), paused, staff]);
  assert.deepEqual(await service.review(staff, { registrationId: pausedId, action: "approve", reason }), { kind: "refused", reason: "submitter_paused" });
});

test("A7_CONCURRENCY two staff approving the same registration at once create exactly one company", async () => {
  const [first, second] = [await person([{ orgId: ROOT, role: "staff", scope: "subtree" }]), await person([{ orgId: ROOT, role: "admin", scope: "subtree" }])];
  const owner = await person();
  const id = await submit(owner);
  const outcomes = await Promise.all([first, second].map((staff) => service.review(staff, { registrationId: id, action: "approve", reason })));
  assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), ["approved", "refused"]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM grants WHERE principal_id = $1", [owner])).rows[0].n, 1);
});
