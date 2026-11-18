import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal, resolveActiveContext } from "@studenthub/contracts";
import { PostgresAccessGrantsStore, PostgresAuthzStore, principalAuditRef, runMigrations } from "@studenthub/db";
import { createAccessGrantService, decideGrantChange, type GrantChangeRequest } from "../../access/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
const SECRET = Buffer.alloc(32, 9);
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresAccessGrantsStore;
let root: string;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  store = new PostgresAccessGrantsStore({ pool });
  // Each test run gets its own operator root, so "last admin" counts are this file's alone.
  root = `a1-root-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: root, name: `Operator ${root}` }));
});
after(async () => pool.end());

async function organization(name: string, parentOrgId = root) {
  const id = `a1-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id, name: `${name} ${id}`, parentOrgId }));
  return id;
}
async function person(displayName = `Person ${randomUUID()}`, grants: { orgId: string; role: string; scope?: "self" | "subtree" }[] = []) {
  const id = `a1-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], displayName, email: `${id}@Example.invalid` }));
  if (grants.length) await authz.grantMany(id, grants);
  return id;
}
const writes = () => createAccessGrantService({ store, secret: SECRET, operatorOrgIds: [root] });
const change = (over: Partial<GrantChangeRequest> & Pick<GrantChangeRequest, "targetPrincipalId" | "orgId">): GrantChangeRequest =>
  ({ role: "recruiter", scope: "self", action: "grant", reason: "Joined the hiring team", ...over });
async function events(target: string) {
  return (await pool.query("SELECT org_id, role, scope, action, actor_principal_id, reason, token_id FROM access_grant_events WHERE target_principal_id = $1 ORDER BY id", [target])).rows;
}
async function audits(target: string) {
  return (await pool.query("SELECT operation, actor_principal_ref, before_summary, after_summary FROM authorization_mutation_audit WHERE target_principal_ref = $1 ORDER BY id", [principalAuditRef(target)])).rows;
}

test("A1_ATOMIC one confirm writes the grant, the audit row and the event; the next resolution sees it", async () => {
  const acme = await organization("Acme");
  const staff = await person("Staff Member", [{ orgId: root, role: "staff", scope: "subtree" }]);
  const target = await person();
  const denied = await resolveActiveContext({ kind: "principal", principalId: target }, { orgId: acme, role: "recruiter" }, authz);
  assert.equal(denied.kind, "denied");
  const preview = await writes().preview(staff, change({ targetPrincipalId: target, orgId: acme }));
  if (!preview.ok || preview.kind !== "change") throw new Error(`expected a change: ${JSON.stringify(preview)}`);
  assert.deepEqual(await events(target), [], "a preview writes nothing");
  assert.deepEqual(await writes().confirm(staff, change({ targetPrincipalId: target, orgId: acme }), preview.token), { kind: "applied", before: null, after: "self" });
  const allowed = await resolveActiveContext({ kind: "principal", principalId: target }, { orgId: acme, role: "recruiter" }, authz);
  assert.equal(allowed.kind, "authorized", "the next request resolves with the new grant, no restart");
  assert.deepEqual(await events(target), [{ org_id: acme, role: "recruiter", scope: "self", action: "grant", actor_principal_id: staff, reason: "Joined the hiring team", token_id: preview.token.tokenId }]);
  const rows = await audits(target);
  assert.deepEqual(rows.at(-1), { operation: "grants.grant", actor_principal_ref: principalAuditRef(staff), before_summary: { grantCount: 0, selfCount: 0, subtreeCount: 0 }, after_summary: { grantCount: 1, selfCount: 1, subtreeCount: 0 } });

  // Revoke goes the same way and the next resolution is denied again.
  const revoke = change({ targetPrincipalId: target, orgId: acme, action: "revoke", reason: "Left the company" });
  const review = await writes().preview(staff, revoke);
  if (!review.ok || review.kind !== "change") throw new Error("expected a change");
  assert.deepEqual(await writes().confirm(staff, revoke, review.token), { kind: "applied", before: "self", after: null });
  assert.equal((await resolveActiveContext({ kind: "principal", principalId: target }, { orgId: acme, role: "recruiter" }, authz)).kind, "denied");
  assert.deepEqual((await events(target)).map((row) => [row.action, row.scope, row.reason]), [["grant", "self", "Joined the hiring team"], ["revoke", "self", "Left the company"]]);
  assert.equal((await audits(target)).at(-1)?.operation, "grants.revoke");
  // Replaying the first token is refused and changes nothing.
  assert.deepEqual(await writes().confirm(staff, change({ targetPrincipalId: target, orgId: acme }), preview.token), { kind: "refused", reason: "token_already_used" });
  assert.equal((await events(target)).length, 2);
});

test("A1_ATOMIC a failure of the event write rolls back the grant and the audit row", async () => {
  const acme = await organization("Acme");
  const admin = await person("Admin", [{ orgId: root, role: "admin", scope: "subtree" }]);
  const target = await person();
  const auditBefore = (await audits(target)).length;
  // A one-character reason passes the decision but fails the events CHECK, which runs last.
  const request = change({ targetPrincipalId: target, orgId: acme, reason: "x" });
  await assert.rejects(store.apply({ callerId: admin, request, tokenId: "e".repeat(64), expectedBefore: null,
    decide: (snapshot) => decideGrantChange(admin, request, snapshot, [root]) }),
  { code: "23514", table: "access_grant_events" }, "the event insert, which runs last, is what fails");
  assert.deepEqual(await authz.listGrantsForPrincipal(target), []);
  assert.equal((await audits(target)).length, auditBefore);
  assert.deepEqual(await events(target), []);
});

test("A1_GUARDS the caller's right is read inside the transaction, and the last admin cannot be removed by two concurrent revokes", async () => {
  const acme = await organization("Acme");
  const staff = await person("Staff", [{ orgId: root, role: "staff", scope: "subtree" }]);
  const target = await person();
  const preview = await writes().preview(staff, change({ targetPrincipalId: target, orgId: acme }));
  if (!preview.ok || preview.kind !== "change") throw new Error("expected a change");
  await authz.revokeMany(staff, [{ orgId: root, role: "staff" }]);
  assert.deepEqual(await writes().confirm(staff, change({ targetPrincipalId: target, orgId: acme }), preview.token), { kind: "refused", reason: "not_allowed" });
  assert.deepEqual(await authz.listGrantsForPrincipal(target), []);

  // Two admins on a fresh operator root revoke each other at the same time: one stays.
  const ops = `a1-ops-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: ops, name: `Ops ${ops}` }));
  const one = await person("One", [{ orgId: ops, role: "admin", scope: "subtree" }]);
  const two = await person("Two", [{ orgId: ops, role: "admin", scope: "subtree" }]);
  const service = createAccessGrantService({ store, secret: SECRET, operatorOrgIds: [ops] });
  const removeTwo = change({ targetPrincipalId: two, orgId: ops, role: "admin", scope: "subtree", action: "revoke", reason: "Rotation" });
  const removeOne = change({ targetPrincipalId: one, orgId: ops, role: "admin", scope: "subtree", action: "revoke", reason: "Rotation" });
  const [a, b] = await Promise.all([service.preview(one, removeTwo), service.preview(two, removeOne)]);
  if (!a.ok || a.kind !== "change" || !b.ok || b.kind !== "change") throw new Error("expected two changes");
  const outcomes = await Promise.all([service.confirm(one, removeTwo, a.token), service.confirm(two, removeOne, b.token)]);
  assert.equal(outcomes.filter((outcome) => outcome.kind === "applied").length, 1, JSON.stringify(outcomes));
  const left = (await pool.query("SELECT count(*)::int AS n FROM grants WHERE org_id = $1 AND role = 'admin'", [ops])).rows[0].n;
  assert.equal(left, 1);
});

test("A1_LIST the person's grants show granter, date and reason, and unknown for older grants; lookups are bounded", async () => {
  const zenith = `Zenith ${randomUUID().slice(0, 8)}`;
  const acme = await organization(zenith);
  const admin = await person("Grace Admin", [{ orgId: root, role: "admin", scope: "subtree" }]);
  const target = await person(`Quinn ${randomUUID().slice(0, 8)}`, [{ orgId: acme, role: "finance" }]);
  const request = change({ targetPrincipalId: target, orgId: acme, role: "org-owner", scope: "subtree", reason: "Founder" });
  const preview = await writes().preview(admin, request);
  if (!preview.ok || preview.kind !== "change") throw new Error("expected a change");
  await writes().confirm(admin, request, preview.token);
  const rows = await store.grants(target);
  const owner = rows.find((row) => row.role === "org-owner")!, finance = rows.find((row) => row.role === "finance")!;
  assert.deepEqual({ ...owner, grantedAt: typeof owner.grantedAt }, { orgId: acme, orgName: `${zenith} ${acme}`, role: "org-owner", scope: "subtree", grantedBy: { principalId: admin, displayName: "Grace Admin" }, grantedAt: "string", reason: "Founder" });
  assert.deepEqual(finance, { orgId: acme, orgName: `${zenith} ${acme}`, role: "finance", scope: "self", grantedBy: null, grantedAt: null, reason: null }, "a grant made before the page is shown as unknown, never hidden");
  const history = await store.history(target);
  assert.deepEqual(history.map((row) => [row.action, row.role, row.actor.displayName, row.reason]), [["grant", "org-owner", "Grace Admin", "Founder"]]);
  assert.deepEqual(await store.ownGrants(target), [
    { orgId: acme, orgName: `${zenith} ${acme}`, role: "finance", scope: "self" },
    { orgId: acme, orgName: `${zenith} ${acme}`, role: "org-owner", scope: "subtree" },
  ]);
  // Exact email, any case; name prefix of at least 3 characters.
  assert.deepEqual((await store.findPeople({ kind: "email", value: `${target}@example.INVALID`.toLowerCase() })).map((row) => row.principalId), [target]);
  const name = (await store.person(target))!.displayName!;
  assert.ok((await store.findPeople({ kind: "name", value: name.slice(0, 12).toUpperCase() })).some((row) => row.principalId === target));
  assert.deepEqual(await store.findPeople({ kind: "name", value: "%%%" }), [], "LIKE wildcards are matched literally");
  const orgs = await store.findOrganizations(zenith.toLowerCase());
  assert.ok(orgs.some((org) => org.orgId === acme && org.ancestors.includes(root)));
  assert.ok((await store.findOrganizations("Zenith")).length <= 25);
  assert.deepEqual((await store.organizations([acme, "missing"])).map((org) => org.orgId), [acme]);
});

test("A1_ATOMIC access grant events are append-only", async () => {
  const acme = await organization("Acme");
  const admin = await person("Admin", [{ orgId: root, role: "admin", scope: "subtree" }]);
  const target = await person();
  const request = change({ targetPrincipalId: target, orgId: acme });
  const preview = await writes().preview(admin, request);
  if (!preview.ok || preview.kind !== "change") throw new Error("expected a change");
  await writes().confirm(admin, request, preview.token);
  await assert.rejects(pool.query("UPDATE access_grant_events SET reason = 'edited' WHERE target_principal_id = $1", [target]), /append-only/);
  await assert.rejects(pool.query("DELETE FROM access_grant_events WHERE target_principal_id = $1", [target]), /append-only/);
});

test("A1_GUARDS a token that expires while the confirm waits for its locks is refused at the write", async () => {
  const acme = await organization("Acme");
  const admin = await person("Admin", [{ orgId: root, role: "admin", scope: "subtree" }]);
  const target = await person();
  const request = change({ targetPrincipalId: target, orgId: acme });
  const outcome = await store.apply({ callerId: admin, request, tokenId: "f".repeat(64), expectedBefore: null,
    decide: (snapshot) => decideGrantChange(admin, request, snapshot, [root]), expiresAt: 1_000, now: () => 1_000 });
  assert.deepEqual(outcome, { kind: "refused", reason: "token_expired" });
  assert.deepEqual(await authz.listGrantsForPrincipal(target), []);
  assert.deepEqual(await events(target), []);
});

test("A1_GUARDS a token that expires while the confirm waits on an organization row lock is refused", async () => {
  const acme = await organization("Acme");
  const admin = await person("Admin", [{ orgId: root, role: "admin", scope: "subtree" }]);
  const target = await person();
  const request = change({ targetPrincipalId: target, orgId: acme });
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [acme]);
    const expiresAt = Date.now() + 300;
    const pending = store.apply({ callerId: admin, request, tokenId: "9".repeat(64), expectedBefore: null,
      decide: (snapshot) => decideGrantChange(admin, request, snapshot, [root]), expiresAt });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await holder.query("ROLLBACK");
    assert.deepEqual(await pending, { kind: "refused", reason: "token_expired" });
  } finally {
    holder.release();
  }
  assert.deepEqual(await authz.listGrantsForPrincipal(target), []);
  assert.deepEqual(await events(target), []);
});

test("A1_GUARDS two staff removing each other's company roles at the same time both succeed without a deadlock", async () => {
  const [acme, zenith] = [await organization("Acme"), await organization("Zenith")];
  const one = await person("One", [{ orgId: root, role: "staff", scope: "subtree" }, { orgId: acme, role: "finance" }]);
  const two = await person("Two", [{ orgId: root, role: "staff", scope: "subtree" }, { orgId: zenith, role: "finance" }]);
  for (let round = 0; round < 5; round += 1) {
    if (round > 0) {
      await authz.grantMany(one, [{ orgId: acme, role: "finance", scope: "self" }]);
      await authz.grantMany(two, [{ orgId: zenith, role: "finance", scope: "self" }]);
    }
    const removeTwo = change({ targetPrincipalId: two, orgId: zenith, role: "finance", action: "revoke", reason: "Left finance" });
    const removeOne = change({ targetPrincipalId: one, orgId: acme, role: "finance", action: "revoke", reason: "Left finance" });
    const [a, b] = await Promise.all([writes().preview(one, removeTwo), writes().preview(two, removeOne)]);
    if (!a.ok || a.kind !== "change" || !b.ok || b.kind !== "change") throw new Error("expected two changes");
    const outcomes = await Promise.all([writes().confirm(one, removeTwo, a.token), writes().confirm(two, removeOne, b.token)]);
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["applied", "applied"]);
  }
});

test("A1_LIST a company deep in the tree still sees the operator root as its ancestor", async () => {
  let parent = root;
  for (let depth = 0; depth < 70; depth += 1) parent = await organization(`Level ${depth}`, parent);
  const staff = await person("Staff", [{ orgId: root, role: "staff", scope: "subtree" }]);
  const target = await person();
  const preview = await writes().preview(staff, change({ targetPrincipalId: target, orgId: parent }));
  assert.ok(preview.ok && preview.kind === "change", JSON.stringify(preview));
});

test("A1_GUARDS a grant to a person paused after the preview is refused and writes nothing", async () => {
  const acme = await organization("Acme");
  const staff = await person("Staff Member", [{ orgId: root, role: "staff", scope: "subtree" }]);
  const target = await person();
  const preview = await writes().preview(staff, change({ targetPrincipalId: target, orgId: acme }));
  if (!preview.ok || preview.kind !== "change") throw new Error("expected a change");
  await pool.query("INSERT INTO account_pauses (id, principal_id, paused_by, reason, suspended_grants, suspended_stores) VALUES ($1, $2, $3, 'Reported misuse', '[]', '[]')",
    [randomUUID(), target, staff]);
  assert.deepEqual(await writes().confirm(staff, change({ targetPrincipalId: target, orgId: acme }), preview.token), { kind: "refused", reason: "state_changed" });
  assert.deepEqual(await events(target), []);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM grants WHERE principal_id = $1", [target])).rows[0].n, 0);
});
