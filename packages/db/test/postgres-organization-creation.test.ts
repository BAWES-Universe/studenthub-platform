import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { organizationCreationDecision, organizationCreationParentAllowed } from "@studenthub/organizations";
import { ORGANIZATION_CREATE_OPERATION, organizationAuditRef, PostgresAuthzStore, PostgresOrganizationCreationStore, runMigrations } from "@studenthub/db";
const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresOrganizationCreationStore;
before(async () => { if (!URL) throw Error("DATABASE_URL is required to run the db suite"); pool = new pg.Pool({ connectionString: URL }); await runMigrations(pool); authz = new PostgresAuthzStore(pool); store = new PostgresOrganizationCreationStore({ pool, decision: organizationCreationDecision, parentAllowed: (p, g) => organizationCreationParentAllowed(p, g, ["root"]) }); await authz.upsertOrganization(createOrganization({ id: "root", name: "Root" })); });
after(async () => pool.end());
async function principal(role = "staff", scope: "self" | "subtree" = "subtree", orgId = "root") { const id = `shu333-${randomUUID()}`; await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` })); await authz.grantMany(id, [{ orgId, role, scope }]); return id; }

test("SHU333_PG_CREATE staff creates company and sub-company with count audits", async () => {
  const actor = await principal(); const company = await store.create(actor, "root", `Company ${randomUUID()}`); assert.equal(company.kind, "created");
  const companyId = (company as { orgId: string }).orgId; const child = await store.create(actor, companyId, `Child ${randomUUID()}`); assert.equal(child.kind, "created"); const childId = (child as { orgId: string }).orgId;
  const rows = await authz.listOrganizations(); assert.equal(rows.find(x => x.id === companyId)?.parentOrgId, "root"); assert.equal(rows.find(x => x.id === childId)?.parentOrgId, companyId);
  for (const [id, before, afterCount] of [[companyId, 0, 1], [childId, 0, 1]] as const) { const audits = await pool.query("SELECT target_org_refs,before_summary,after_summary FROM authorization_mutation_audit WHERE operation=$1 AND target_org_refs=$2::text[]", [ORGANIZATION_CREATE_OPERATION, [organizationAuditRef(id)]]); assert.equal(audits.rowCount, 1); assert.deepEqual(audits.rows[0], { target_org_refs: [organizationAuditRef(id)], before_summary: { childCount: before }, after_summary: { childCount: afterCount } }); }
});

test("SHU333_PG_REFUSED disallowed and dead parents write nothing", async () => {
  for (const [role, scope] of [["staff", "self"], ["org-owner", "subtree"], ["recruiter", "subtree"]] as const) assert.deepEqual(await store.create(await principal(role, scope), "root", `No ${randomUUID()}`), { kind: "not_found" });
  const actor = await principal(); assert.deepEqual(await store.create(actor, "unknown", "No"), { kind: "not_found" });
  const dead = `dead-${randomUUID()}`; await authz.upsertOrganization(createOrganization({ id: dead, name: dead, parentOrgId: "root" })); await pool.query("INSERT INTO organization_deletions(org_id,receipt_ref) VALUES($1,$2)", [dead, "a".repeat(64)]); assert.deepEqual(await store.create(actor, dead, "No"), { kind: "not_found" });
  assert.equal((await pool.query("SELECT 1 FROM authorization_mutation_audit WHERE operation=$1 AND actor_principal_ref IS NOT NULL AND target_org_refs='{}'", [ORGANIZATION_CREATE_OPERATION])).rowCount, 0);
});

test("SHU333_PG_HIERARCHY a sub-company cannot have children", async () => { const actor = await principal(), a = await store.create(actor, "root", `A ${randomUUID()}`), b = await store.create(actor, (a as { orgId: string }).orgId, `B ${randomUUID()}`); assert.deepEqual(await store.create(actor, (b as { orgId: string }).orgId, "Too deep"), { kind: "hierarchy" }); });

test("SHU333_PG_NAME_TAKEN names are unique case-insensitively only under one parent", async () => { const actor = await principal(), suffix = randomUUID(), a = await store.create(actor, "root", `Parent ${suffix}`), b = await store.create(actor, "root", `Other ${suffix}`); assert.equal((await store.create(actor, (a as { orgId: string }).orgId, "Acme")).kind, "created"); assert.deepEqual(await store.create(actor, (a as { orgId: string }).orgId, "ACME"), { kind: "name_taken" }); assert.equal((await store.create(actor, (b as { orgId: string }).orgId, "acme")).kind, "created"); });

test("SHU333_PG_RACE deletion wins while create waits", async () => { const actor = await principal(), made = await store.create(actor, "root", `Race ${randomUUID()}`), parent = (made as { orgId: string }).orgId; const auditBefore = Number((await pool.query<{ count: string }>("SELECT count(*)::text count FROM authorization_mutation_audit WHERE operation=$1", [ORGANIZATION_CREATE_OPERATION])).rows[0]!.count); let locker: pg.PoolClient | undefined; try { locker = await pool.connect(); await locker.query("BEGIN"); await locker.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [parent]); await locker.query("INSERT INTO organization_deletions(org_id,receipt_ref) VALUES($1,$2)", [parent, "b".repeat(64)]); const pid = (await locker.query("SELECT pg_backend_pid() pid")).rows[0].pid, pending = store.create(actor, parent, "Blocked child"); let waiting = false; for (let n = 0; n < 100 && !waiting; n++) { waiting = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid<>$1 AND pid<>pg_backend_pid() AND wait_event_type='Lock'", [pid])).rowCount !== 0; if (!waiting) await new Promise(r => setTimeout(r, 100)); } assert.equal(waiting, true); await locker.query("COMMIT"); assert.deepEqual(await pending, { kind: "not_found" }); assert.equal((await pool.query("SELECT 1 FROM organizations WHERE parent_org_id=$1 AND name='Blocked child'", [parent])).rowCount, 0); assert.equal(Number((await pool.query<{ count: string }>("SELECT count(*)::text count FROM authorization_mutation_audit WHERE operation=$1", [ORGANIZATION_CREATE_OPERATION])).rows[0]!.count), auditBefore); } finally { if (locker) { try { await locker.query("ROLLBACK"); } catch {} locker.release(); } } });
