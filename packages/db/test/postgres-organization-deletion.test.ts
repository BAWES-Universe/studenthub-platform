import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { buildOrganizationDeletionWrite, organizationDeletionBlockers, organizationDeletionDecision, organizationDeletionPrincipalRef, organizationDeletionRecordRef } from "@studenthub/organizations";
import { ORGANIZATION_DELETION_OPERATION, organizationAuditRef, PostgresAuthzStore, PostgresOrganizationDeletionStore, runMigrations } from "@studenthub/db";

const URL = process.env.DATABASE_URL ?? "", KEY = "shu326-postgres-secret-at-least-thirty-two-bytes";
const ROOT = `shu326-root-${randomUUID()}`;
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresOrganizationDeletionStore, admin: string, candidate: string, currency: string;
before(async () => {
  if (!URL) throw new Error("DATABASE_URL is required to run the organization deletion db suite");
  pool = new pg.Pool({ connectionString: URL }); await runMigrations(pool); authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: ROOT, name: "Synthetic SHU-326 operator" }));
  admin = await principal(); candidate = await principal();
  await authz.grantMany(admin, [{ orgId: ROOT, role: "admin", scope: "subtree" }]);
  currency = randomUUID();
  await pool.query(`INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,status,created_by_ref,updated_by_ref,created_at,updated_at)
    VALUES($1,'currency',$2,$2,'active',$3,$3,clock_timestamp(),clock_timestamp())`, [currency, `SHU326-${currency}`, "c".repeat(64)]);
  store = new PostgresOrganizationDeletionStore({ pool, decision: organizationDeletionDecision, blockers: organizationDeletionBlockers, recordRef: organizationDeletionRecordRef, principalRef: organizationDeletionPrincipalRef });
});
after(async () => pool.end());
async function principal() { const id = `shu326-person-${randomUUID()}`; await authz.registerPrincipal(createPrincipal({ id })); return id; }
async function org(parent = ROOT) { const id = `shu326-org-${randomUUID()}`; await authz.upsertOrganization(createOrganization({ id, name: id, ...(parent ? { parentOrgId: parent } : {}) })); return id; }
function writer(person: string, orgId: string) { return buildOrganizationDeletionWrite({ store: store.forPrincipal(person, orgId), secret: KEY }); }
function change(orgId: string) { return { personRef: organizationDeletionRecordRef(orgId), field: "deletion", value: "deleted" }; }
async function preview(person: string, orgId: string) { return writer(person, orgId).preview({ principalRef: organizationDeletionPrincipalRef(person), change: change(orgId) }); }
async function remove(person: string, orgId: string) { const w = writer(person, orgId), p = await preview(person, orgId); assert.ok(p.ok); const done = await w.confirm({ principalRef: organizationDeletionPrincipalRef(person), change: change(orgId), token: p.token }); assert.ok(done.ok); return done.receipt; }
async function contract(orgId: string, status: "active" | "inactive" | "deleted") { const id = randomUUID(), deleted = status === "deleted"; await pool.query(`INSERT INTO pay_contracts(id,candidate_principal_id,company_org_id,store_id,pay_model,start_date,currency_id,transfer_cost,auto_generate,status,candidate_hourly_rate,company_hourly_rate,created_at,updated_at,deleted_at)
  VALUES($1,$2,$3,$4,'hourly','2026-01-01',$5,0,false,$6,1,2,clock_timestamp(),clock_timestamp(),$7)`, [id, candidate, orgId, `store-${id}`, currency, status, deleted ? new Date() : null]); return id; }

test("SHU-326 postgres subtree admin soft-deletes and reads its audit receipt", async () => {
  const id = await org(); const author = await principal();
  await pool.query("INSERT INTO organization_notes(org_id,author_principal_id,body,receipt_ref) VALUES($1,$2,'preserved',$3)", [id, author, randomBytes(32).toString("hex")]);
  await contract(id, "deleted"); const receipt = await remove(admin, id);
  assert.equal((await pool.query("SELECT count(*)::int n FROM organizations WHERE id=$1", [id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM organization_notes WHERE org_id=$1", [id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM pay_contracts WHERE company_org_id=$1 AND status='deleted'", [id])).rows[0].n, 1);
  assert.equal(await store.isDeleted(id), true); assert.equal((await store.deletedAmong([id, ROOT])).has(id), true);
  const audit = await pool.query("SELECT operation,target_org_refs,after_summary->'fields' fields FROM authorization_mutation_audit WHERE request_ref=$1", [receipt.receiptRef]);
  assert.deepEqual(audit.rows, [{ operation: ORGANIZATION_DELETION_OPERATION, target_org_refs: [organizationAuditRef(id)], fields: ["deletion"] }]);
  assert.deepEqual(await store.readReceipt(admin, id, receipt.receiptRef), receipt);
  assert.deepEqual(await preview(admin, id), { ok: false, reason: "not_own_record" });
});

test("SHU-326 postgres refuses staff, owner and the operator organization", async () => {
  for (const role of ["staff", "org-owner"] as const) { const id = await org(), person = await principal(); await authz.grantMany(person, [{ orgId: id, role, scope: "self" }]); assert.deepEqual(await preview(person, id), { ok: false, reason: "not_own_record" }); }
  await authz.upsertOrganization(createOrganization({ id: "root", name: "Reserved operator" })); const operatorAdmin = await principal(); await authz.grantMany(operatorAdmin, [{ orgId: "root", role: "admin", scope: "self" }]);
  assert.deepEqual(await preview(operatorAdmin, "root"), { ok: false, reason: "not_own_record" });
});

test("SHU-326 postgres dependency blockers are ordered and deleted dependencies do not block", async () => {
  const parent = await org(), child = await org(parent);
  assert.deepEqual(await store.blockers(admin, parent), ["live_sub_organizations"]); await remove(admin, child); assert.deepEqual(await store.blockers(admin, parent), []); await remove(admin, parent);
  const live = await org(); await contract(live, "inactive"); assert.deepEqual(await store.blockers(admin, live), ["live_pay_contracts"]);
  const deleted = await org(); await contract(deleted, "deleted"); assert.deepEqual(await store.blockers(admin, deleted), []);
  const memberOrg = await org(), member = await principal(); await authz.grantMany(member, [{ orgId: memberOrg, role: "staff", scope: "self" }]); assert.deepEqual(await store.blockers(admin, memberOrg), ["member_grants"]);
});

test("SHU-326 postgres confirm rechecks dependencies and duplicate tokens", async () => {
  const stale = await org(), w = writer(admin, stale), p = await preview(admin, stale); assert.ok(p.ok); const member = await principal(); await authz.grantMany(member, [{ orgId: stale, role: "staff", scope: "self" }]);
  assert.deepEqual(await w.confirm({ principalRef: organizationDeletionPrincipalRef(admin), change: change(stale), token: p.token }), { ok: false, reason: "state_changed" });
  assert.equal((await pool.query("SELECT count(*)::int n FROM organization_deletions WHERE org_id=$1", [stale])).rows[0].n, 0);
  const duplicate = await org(), dw = writer(admin, duplicate), dp = await preview(admin, duplicate); assert.ok(dp.ok); assert.ok((await dw.confirm({ principalRef: organizationDeletionPrincipalRef(admin), change: change(duplicate), token: dp.token })).ok);
  assert.deepEqual(await dw.confirm({ principalRef: organizationDeletionPrincipalRef(admin), change: change(duplicate), token: dp.token }), { ok: false, reason: "token_already_used" });
});

test("SHU-326 postgres deletion records are append-only and prevent hard deletion", async () => {
  const id = await org(); await remove(admin, id);
  await assert.rejects(pool.query("UPDATE organization_deletions SET deleted_at=clock_timestamp() WHERE org_id=$1", [id]), (e: unknown) => (e as { code?: string }).code === "23514");
  await assert.rejects(pool.query("DELETE FROM organization_deletions WHERE org_id=$1", [id]), (e: unknown) => (e as { code?: string }).code === "23514");
  await assert.rejects(pool.query("DELETE FROM organizations WHERE id=$1", [id]), (e: unknown) => (e as { code?: string }).code === "23503");
  await assert.rejects(pool.query("INSERT INTO authorization_mutation_audit(request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary) VALUES($1,$1,'organization.deletion.safe_write',$1,ARRAY[$1]::text[],'{\"valuePresent\":false}','{\"valuePresent\":false}')", ["d".repeat(64)]), (e: unknown) => (e as { code?: string }).code === "23514", "a deletion audit row without its receipt half is refused");
});
