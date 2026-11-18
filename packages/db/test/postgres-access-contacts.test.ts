import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAccessContactsStore, PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { createCompanyContactsService, type CompanyContactsService, type ContactInput } from "../../access/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresAccessContactsStore, contacts: CompanyContactsService;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  store = new PostgresAccessContactsStore({ pool });
  contacts = createCompanyContactsService({ store });
});
after(async () => pool.end());

async function company(name = "Acme", parentOrgId?: string) {
  const id = `a3-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id, name: `${name} ${id}`, ...(parentOrgId ? { parentOrgId } : {}) }));
  return id;
}
async function person(grants: { orgId: string; role: string; scope?: "self" | "subtree" }[] = [], email = `a3-${randomUUID()}@example.com`) {
  const id = `a3-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], displayName: `Person ${id}`, email }));
  if (grants.length) await authz.grantMany(id, grants);
  return id;
}
const contact = (over: Partial<ContactInput> = {}): ContactInput => ({
  name: "Layla Accountant", roleTitle: "Accountant",
  phones: [{ value: "+96555551234", label: "Mobile" }, { value: "22223333", label: null }],
  emails: [{ value: "layla@acme.example", label: "Work" }], ...over,
});
const snapshotOf = async () => (await pool.query("SELECT count(*)::int AS grants FROM grants")).rows[0].grants as number;

test("A3_CONTACT owners and staff write contacts with their channels; a recruiter cannot; a contact holds no grant", async () => {
  const root = await company("Operator");
  const acme = await company("Acme", root);
  const owner = await person([{ orgId: acme, role: "org-owner" }]);
  const staff = await person([{ orgId: root, role: "staff", scope: "subtree" }]);
  const recruiter = await person([{ orgId: acme, role: "recruiter" }]);
  const grantsBefore = await snapshotOf();
  const created = await contacts.create(owner, acme, contact());
  assert.equal(created.kind, "created");
  if (created.kind !== "created") return;
  assert.equal((await contacts.create(staff, acme, contact({ name: "Branch Manager", phones: [], emails: [] }))).kind, "created");
  assert.deepEqual(await contacts.create(recruiter, acme, contact()), { kind: "refused", reason: "not_allowed" });
  assert.equal(await snapshotOf(), grantsBefore, "no grant was created");
  const listed = await store.contacts(acme);
  assert.deepEqual(listed.map((item) => [item.name, item.roleTitle, item.phones, item.emails]), [
    ["Branch Manager", "Accountant", [], []],
    ["Layla Accountant", "Accountant", [{ value: "+96555551234", label: "Mobile" }, { value: "22223333", label: null }], [{ value: "layla@acme.example", label: "Work" }]],
  ]);
  assert.deepEqual(await contacts.update(owner, acme, created.id, contact({ name: "Layla A.", phones: [{ value: "99990000", label: null }], emails: [] })), { kind: "updated" });
  const updated = (await store.contacts(acme)).find((item) => item.id === created.id)!;
  assert.deepEqual([updated.name, updated.phones, updated.emails], ["Layla A.", [{ value: "99990000", label: null }], []]);
  assert.deepEqual(await contacts.update(recruiter, acme, created.id, contact()), { kind: "refused", reason: "not_allowed" });
  const other = await company("Other");
  assert.deepEqual(await contacts.update(owner, other, created.id, contact()), { kind: "refused", reason: "not_allowed" }, "an owner of A cannot reach B's contact");
  // The database refuses a bad channel even if the rules were bypassed.
  await assert.rejects(pool.query("INSERT INTO company_contact_channels (contact_id, kind, position, value) VALUES ($1, 'phone', 5, '22223333')", [created.id]));
  await assert.rejects(pool.query("INSERT INTO company_contact_channels (contact_id, kind, position, value) VALUES ($1, 'email', 4, 'Not An Email')", [created.id]));
});

test("A3_READ_SITES owners, recruiters, finance, staff and admin read; candidates and others get nothing", async () => {
  const root = await company("Operator");
  const acme = await company("Acme", root);
  const owner = await person([{ orgId: acme, role: "org-owner" }]);
  await contacts.create(owner, acme, contact());
  for (const grants of [[{ orgId: acme, role: "recruiter" }], [{ orgId: acme, role: "finance" }], [{ orgId: root, role: "admin", scope: "subtree" as const }]]) {
    const view = await contacts.view(await person(grants), acme);
    assert.equal(view?.contacts.length, 1);
    assert.equal(view?.writable, grants[0]!.role === "admin");
  }
  assert.equal(await contacts.view(await person([{ orgId: acme, role: "candidate" }]), acme), null);
  assert.equal(await contacts.view(await person([{ orgId: await company("Other"), role: "org-owner" }]), acme), null);
  assert.equal(await contacts.view(owner, `a3-org-${randomUUID()}`), null);
});

test("A3_REMOVE removal keeps the row with removed_at, is never listed, and touches no grant, principal or member", async () => {
  const acme = await company();
  const owner = await person([{ orgId: acme, role: "org-owner" }]);
  const email = `a3-member-${randomUUID()}@example.com`;
  const member = await person([{ orgId: acme, role: "recruiter" }], email);
  const created = await contacts.create(owner, acme, contact({ name: "Same Address", emails: [{ value: email, label: null }] }));
  if (created.kind !== "created") throw new Error(JSON.stringify(created));
  const grantsBefore = (await pool.query("SELECT principal_id, org_id, role, scope FROM grants WHERE org_id = $1 ORDER BY principal_id, role", [acme])).rows;
  assert.deepEqual(await contacts.remove(owner, acme, created.id), { kind: "removed" });
  assert.deepEqual(await store.contacts(acme), []);
  const row = (await pool.query("SELECT removed_by, (SELECT count(*)::int FROM company_contact_channels WHERE contact_id = $1) AS channels FROM company_contacts WHERE id = $1", [created.id])).rows[0];
  assert.deepEqual(row, { removed_by: owner, channels: 3 }, "its channels stay with it");
  assert.deepEqual((await pool.query("SELECT principal_id, org_id, role, scope FROM grants WHERE org_id = $1 ORDER BY principal_id, role", [acme])).rows, grantsBefore);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM principals WHERE id = $1", [member])).rows[0].n, 1);
  assert.deepEqual(await contacts.remove(owner, acme, created.id), { kind: "refused", reason: "not_found" });
  assert.deepEqual(await contacts.update(owner, acme, created.id, contact()), { kind: "refused", reason: "not_found" });
  await assert.rejects(pool.query("UPDATE company_contacts SET removed_at = NULL, removed_by = NULL WHERE id = $1", [created.id]), /cannot change/);
  await assert.rejects(pool.query("DELETE FROM company_contacts WHERE id = $1", [created.id]), /never deleted/);
});

/** Revokes every grant the person holds in a transaction that commits while `write` waits on it, as a grant change or pause would. */
async function revokedDuring<T>(principalId: string, write: () => Promise<T>): Promise<T> {
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 5959))", [principalId]);
    await holder.query("DELETE FROM grants WHERE principal_id = $1", [principalId]);
    const pending = write();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await holder.query("COMMIT");
    return await pending;
  } finally {
    holder.release();
  }
}

test("A3_CONTACT an owner whose grant is revoked while the write waits writes nothing", async () => {
  const acme = await company();
  const owner = await person([{ orgId: acme, role: "org-owner" }]);
  const outcome = await revokedDuring(owner, () => contacts.create(owner, acme, contact()));
  assert.equal(outcome.kind, "refused");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM company_contacts WHERE org_id = $1", [acme])).rows[0].n, 0);
});
