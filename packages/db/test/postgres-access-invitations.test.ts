import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal, resolveActiveContext } from "@studenthub/contracts";
import { PostgresAccessGrantsStore, PostgresAccessInvitationsStore, PostgresAuthzStore, principalAuditRef, runMigrations } from "@studenthub/db";
import { createCompanyTeamService, hashInvitationToken, recordingInvitationMailer, type CompanyTeamService } from "../../access/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
const ORIGIN = "https://hub.example";
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresAccessInvitationsStore, reads: PostgresAccessGrantsStore;
let clock = new Date("2026-11-17T10:00:00Z");

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  store = new PostgresAccessInvitationsStore({ pool });
  reads = new PostgresAccessGrantsStore({ pool });
});
after(async () => pool.end());

const service = (mailer = recordingInvitationMailer()): CompanyTeamService => createCompanyTeamService({ store, mailer, now: () => clock });

async function company(name = "Acme", parentOrgId?: string) {
  const id = `a2-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id, name: `${name} ${id}`, ...(parentOrgId ? { parentOrgId } : {}) }));
  return id;
}
async function person(email: string, grants: { orgId: string; role: string; scope?: "self" | "subtree" }[] = []) {
  const id = `a2-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], displayName: `Person ${email}`, email }));
  if (grants.length) await authz.grantMany(id, grants);
  return id;
}
const address = () => `invitee-${randomUUID()}@example.com`;
const tokenOf = (link: string) => link.split("/invitations/")[1]!;
async function invite(owner: string, orgId: string, email: string, role = "recruiter", scope: "self" | "subtree" = "self") {
  const result = await service().invite(owner, orgId, { email, role, scope }, ORIGIN);
  if (result.kind !== "invited") throw new Error(`expected an invitation: ${JSON.stringify(result)}`);
  return tokenOf(result.link);
}
async function grantsOn(principalId: string, orgId: string) {
  return (await pool.query("SELECT role, scope FROM grants WHERE principal_id = $1 AND org_id = $2 ORDER BY role", [principalId, orgId])).rows;
}
async function events(principalId: string) {
  return (await pool.query("SELECT org_id, role, scope, action, actor_principal_id, reason FROM access_grant_events WHERE target_principal_id = $1 ORDER BY id", [principalId])).rows;
}
async function audits(principalId: string) {
  return (await pool.query("SELECT operation, actor_principal_ref FROM authorization_mutation_audit WHERE target_principal_ref = $1 ORDER BY id", [principalAuditRef(principalId)])).rows;
}

test("A2_INVITE an invitation stores the hash and the address, refuses duplicates and caps at 50 pending", async () => {
  const acme = await company();
  const owner = await person(address(), [{ orgId: acme, role: "org-owner" }]);
  const email = address();
  const token = await invite(owner, acme, email.toUpperCase());
  const rows = (await pool.query("SELECT role, scope, invited_email_normalized, token_hash, invited_by, (expires_at - created_at)::text AS ttl FROM company_invitations WHERE org_id = $1", [acme])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invited_email_normalized, email);
  assert.equal(rows[0].token_hash, hashInvitationToken(token));
  assert.equal(rows[0].invited_by, owner);
  assert.equal(rows[0].ttl, "7 days");
  assert.equal(JSON.stringify(rows).includes(token), false);
  assert.deepEqual(await service().invite(owner, acme, { email, role: "recruiter", scope: "self" }, ORIGIN), { kind: "refused", reason: "duplicate_invitation" });
  assert.equal((await service().invite(owner, acme, { email, role: "finance", scope: "self" }, ORIGIN)).kind, "invited", "another role is another invitation");
  assert.deepEqual(await service().invite(owner, acme, { email: address(), role: "recruiter", scope: "subtree" }, ORIGIN), { kind: "refused", reason: "role_not_allowed" });
  const recruiter = await person(address(), [{ orgId: acme, role: "recruiter" }]);
  assert.deepEqual(await service().invite(recruiter, acme, { email: address(), role: "recruiter", scope: "self" }, ORIGIN), { kind: "refused", reason: "not_owner" });
  for (let index = 2; index < 50; index += 1) await invite(owner, acme, address());
  assert.deepEqual(await service().invite(owner, acme, { email: address(), role: "recruiter", scope: "self" }, ORIGIN), { kind: "refused", reason: "too_many_invitations" });
  // An expired pending invitation for the same key gives way to a new one.
  const other = await company();
  const otherOwner = await person(address(), [{ orgId: other, role: "org-owner" }]);
  const again = address();
  await invite(otherOwner, other, again);
  const saved = clock;
  clock = new Date(clock.getTime() + 8 * 24 * 3600 * 1000);
  try {
    await invite(otherOwner, other, again);
  } finally { clock = saved; }
  const states = (await pool.query("SELECT revoked_by IS NOT NULL AS revoked FROM company_invitations WHERE org_id = $1 ORDER BY created_at", [other])).rows;
  assert.deepEqual(states, [{ revoked: true }, { revoked: false }]);
});

test("A2_ACCEPT the grant exists only after acceptance, bound to the signed-in principal, with one event by the inviter", async () => {
  const acme = await company();
  const owner = await person(address(), [{ orgId: acme, role: "org-owner" }]);
  const email = address();
  const invitee = await person(email.toUpperCase());
  const token = await invite(owner, acme, email);
  assert.deepEqual(await grantsOn(invitee, acme), [], "inviting gives nothing");
  assert.deepEqual(await events(invitee), []);
  assert.equal((await resolveActiveContext({ kind: "principal", principalId: invitee }, { orgId: acme, role: "recruiter" }, authz)).kind, "denied");
  const page = await service().invitation(token);
  assert.equal(page?.role, "recruiter");
  assert.equal(JSON.stringify(page).includes(email), false, "the invitation page never carries the address");
  assert.deepEqual(await service().accept(token, invitee), { kind: "accepted", orgId: acme, role: "recruiter" });
  assert.deepEqual(await grantsOn(invitee, acme), [{ role: "recruiter", scope: "self" }]);
  assert.deepEqual(await events(invitee), [{ org_id: acme, role: "recruiter", scope: "self", action: "grant", actor_principal_id: owner, reason: "Invitation accepted" }]);
  assert.deepEqual((await audits(invitee)).map((row) => row.operation).filter((op) => op.startsWith("grants.")), ["grants.grant"], "registration aside, one grant audit");
  assert.equal((await resolveActiveContext({ kind: "principal", principalId: invitee }, { orgId: acme, role: "recruiter" }, authz)).kind, "authorized");
  // S1: the invitee's own list and the owner's Team page show it on the next read.
  assert.ok((await reads.ownGrants(invitee)).some((row) => row.orgId === acme && row.role === "recruiter"));
  const team = await service().team(owner, acme);
  assert.ok(team?.members.some((member) => member.principalId === invitee && member.role === "recruiter"));
  assert.equal(team?.invitations.length, 0);
});

test("A2_MATCH a different current address is refused without consuming the invitation; the current email is read at acceptance", async () => {
  const acme = await company();
  const owner = await person(address(), [{ orgId: acme, role: "org-owner" }]);
  const email = address();
  const someone = await person(address());
  const token = await invite(owner, acme, email);
  assert.deepEqual(await service().accept(token, someone), { kind: "wrong_address" });
  assert.deepEqual(await grantsOn(someone, acme), []);
  assert.notEqual(await service().invitation(token), null, "still pending");
  await pool.query("UPDATE principals SET email = $2 WHERE id = $1", [someone, ` ${email.toUpperCase()} `]);
  assert.deepEqual(await service().accept(token, someone), { kind: "accepted", orgId: acme, role: "recruiter" });
  // A principal whose email changed away after inviting cannot use a second link.
  const second = await invite(owner, acme, email, "finance");
  await pool.query("UPDATE principals SET email = $2 WHERE id = $1", [someone, address()]);
  assert.deepEqual(await service().accept(second, someone), { kind: "wrong_address" });
});

test("A2_REPLAY twice, after revocation, after expiry, after the inviter lost the right, and concurrently: one grant, one event", async () => {
  const acme = await company();
  const owner = await person(address(), [{ orgId: acme, role: "org-owner" }]);
  const email = address();
  const invitee = await person(email);
  const token = await invite(owner, acme, email);
  const results = await Promise.all([service().accept(token, invitee), service().accept(token, invitee), service().accept(token, invitee)]);
  assert.deepEqual(results.map((result) => result.kind).sort(), ["accepted", "invalid", "invalid"]);
  assert.deepEqual(await service().accept(token, invitee), { kind: "invalid" });
  assert.equal((await events(invitee)).length, 1);
  assert.equal((await grantsOn(invitee, acme)).length, 1);

  const revoked = await invite(owner, acme, email, "finance");
  const pending = (await pool.query("SELECT id FROM company_invitations WHERE token_hash = $1", [hashInvitationToken(revoked)])).rows[0].id;
  assert.deepEqual(await service().revoke(owner, acme, pending), { kind: "revoked" });
  assert.equal(await service().invitation(revoked), null);
  assert.deepEqual(await service().accept(revoked, invitee), { kind: "invalid" });
  assert.deepEqual(await service().revoke(owner, acme, pending), { kind: "refused", reason: "not_found" });

  const expiring = await invite(owner, acme, email, "org-owner");
  const saved = clock;
  clock = new Date(clock.getTime() + 7 * 24 * 3600 * 1000);
  try {
    assert.equal(await service().invitation(expiring), null);
    assert.deepEqual(await service().accept(expiring, invitee), { kind: "invalid" });
  } finally { clock = saved; }

  const beta = await company("Beta");
  const formerOwner = await person(address(), [{ orgId: beta, role: "org-owner" }]);
  const stale = await invite(formerOwner, beta, email);
  await pool.query("DELETE FROM grants WHERE principal_id = $1", [formerOwner]);
  assert.deepEqual(await service().accept(stale, invitee), { kind: "invalid" });
  assert.deepEqual(await grantsOn(invitee, beta), []);
  assert.equal((await events(invitee)).length, 1);
});

test("A2_REMOVE removing a member takes this company's grants only; the last owner stays under concurrency", async () => {
  const parent = await company("Group");
  const child = await company("Store", parent);
  const ownerA = await person(address(), [{ orgId: parent, role: "org-owner" }]);
  const ownerB = await person(address(), [{ orgId: parent, role: "org-owner" }]);
  const member = await person(address(), [{ orgId: parent, role: "recruiter" }, { orgId: parent, role: "finance" }, { orgId: child, role: "recruiter" }]);
  assert.deepEqual(await service().remove(ownerA, parent, member), { kind: "removed", roles: ["finance", "recruiter"] });
  assert.deepEqual(await grantsOn(member, parent), []);
  assert.deepEqual(await grantsOn(member, child), [{ role: "recruiter", scope: "self" }], "a child's grant stays");
  assert.deepEqual((await events(member)).map((row) => [row.role, row.action, row.actor_principal_id]), [["finance", "revoke", ownerA], ["recruiter", "revoke", ownerA]]);
  assert.deepEqual((await audits(member)).map((row) => row.operation).at(-1), "grants.revoke");
  assert.equal((await audits(member)).filter((row) => row.operation === "grants.revoke").length, 1, "one audit row for the removal");
  assert.deepEqual(await service().remove(ownerA, parent, member), { kind: "refused", reason: "not_found" });

  const results = await Promise.all([service().remove(ownerA, parent, ownerB), service().remove(ownerB, parent, ownerA)]);
  assert.equal(results.filter((result) => result.kind === "removed").length, 1, JSON.stringify(results));
  const owners = (await pool.query("SELECT count(*)::int AS n FROM grants WHERE org_id = $1 AND role = 'org-owner'", [parent])).rows[0].n;
  assert.equal(owners, 1, "two concurrent removals of the last two owners leave one");
  const last = results[0]!.kind === "removed" ? ownerA : ownerB;
  assert.deepEqual(await service().remove(last, parent, last), { kind: "refused", reason: "last_owner" });
});

test("A2_TEAM_PAGE owners write, operator staff and admin read, anyone else gets nothing", async () => {
  const root = await company("Operator");
  const acme = await company("Acme", root);
  const owner = await person(address(), [{ orgId: acme, role: "org-owner" }]);
  const staff = await person(address(), [{ orgId: root, role: "staff", scope: "subtree" }]);
  const recruiter = await person(address(), [{ orgId: acme, role: "recruiter" }]);
  assert.equal((await service().team(owner, acme))?.writable, true);
  assert.equal((await service().team(staff, acme))?.writable, false);
  assert.equal(await service().team(recruiter, acme), null);
  assert.equal(await service().team(owner, `a2-org-${randomUUID()}`), null);
});

test("A2_REPLAY a link that expires while acceptance waits on the company lock is refused", async () => {
  const acme = await company();
  const owner = await person(address(), [{ orgId: acme, role: "org-owner" }]);
  const email = address();
  const invitee = await person(email);
  const token = await invite(owner, acme, email);
  const saved = clock;
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 5960))", [`access:org:${acme}`]);
    const pending = service().accept(token, invitee);
    await new Promise((resolve) => setTimeout(resolve, 200));
    clock = new Date(saved.getTime() + 7 * 24 * 3600 * 1000);
    await holder.query("COMMIT");
    assert.deepEqual(await pending, { kind: "invalid" });
  } finally {
    clock = saved;
    holder.release();
  }
  assert.deepEqual(await grantsOn(invitee, acme), []);
  assert.deepEqual(await service().accept(token, invitee), { kind: "accepted", orgId: acme, role: "recruiter" }, "still live once the clock is back");
});

test("A2_ACCEPT a paused person's acceptance grants nothing and leaves the link unused", async () => {
  const acme = await company();
  const owner = await person(address(), [{ orgId: acme, role: "org-owner" }]);
  const email = address();
  const invitee = await person(email);
  const token = await invite(owner, acme, email);
  await pool.query("INSERT INTO account_pauses (id, principal_id, paused_by, reason, suspended_grants, suspended_stores) VALUES ($1, $2, $3, 'Reported misuse', '[]', '[]')",
    [randomUUID(), invitee, owner]);
  assert.deepEqual(await service().accept(token, invitee), { kind: "invalid" });
  assert.deepEqual(await grantsOn(invitee, acme), []);
  assert.equal((await pool.query("SELECT used_at FROM company_invitations WHERE token_hash = $1", [hashInvitationToken(token)])).rows[0].used_at, null);
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

test("A2_INVITE an owner whose grant is revoked while the invite waits invites nobody", async () => {
  const acme = await company();
  const owner = await person(address(), [{ orgId: acme, role: "org-owner" }]);
  const outcome = await revokedDuring(owner, () => service().invite(owner, acme, { email: address(), role: "recruiter", scope: "self" }, ORIGIN));
  assert.equal(outcome.kind, "refused");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM company_invitations WHERE org_id = $1", [acme])).rows[0].n, 0);
});
