import { randomUUID } from "node:crypto";
import pg from "pg";
import { databaseUrl } from "./connection.js";
import { organizationAuditRef, principalAuditRef, requestAuditRef } from "./authorization-audit.js";
import { organizationLive } from "./organization-liveness.js";

export const ORGANIZATION_CREATE_OPERATION = "organization.create";
type Grant = { org_id: string; role: string; scope: string };
type Decision = (rows: readonly Grant[], parentId: string, ancestors: readonly string[]) => boolean;
type ParentAllowed = (parentId: string, parentOfParent: string | null) => boolean;
export type OrganizationCreateResult = { kind: "created"; orgId: string } | { kind: "not_found" | "hierarchy" | "name_taken" };

export class PostgresOrganizationCreationStore {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(readonly options: { connectionString?: string; pool?: pg.Pool; decision: Decision; parentAllowed: ParentAllowed }) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close() { if (this.#owns) await this.#pool.end(); }

  async create(principalId: string, parentId: string, name: string): Promise<OrganizationCreateResult> {
    return this.#transaction(parentId, async (c) => {
      // The parent's FOR SHARE lock races safely with deletion's FOR UPDATE: the
      // winner either commits a child that blocks deletion, or a deletion seen by organizationLive's second statement.
      if (!await organizationLive(c, parentId, true)) return { rollback: { kind: "not_found" } as OrganizationCreateResult };
      const grants = await c.query<Grant>("SELECT org_id,role,scope FROM grants WHERE principal_id=$1 FOR SHARE", [principalId]);
      const ancestors = await c.query<{ id: string }>("WITH RECURSIVE chain AS (SELECT id,parent_org_id FROM organizations WHERE id=$1 UNION ALL SELECT o.id,o.parent_org_id FROM organizations o JOIN chain c ON c.parent_org_id=o.id) SELECT id FROM chain WHERE id<>$1", [parentId]);
      if (!this.options.decision(grants.rows, parentId, ancestors.rows.map((row) => row.id))) return { rollback: { kind: "not_found" } as OrganizationCreateResult };
      const parent = await c.query<{ parent_org_id: string | null }>("SELECT parent_org_id FROM organizations WHERE id=$1", [parentId]);
      if (!this.options.parentAllowed(parentId, parent.rows[0]!.parent_org_id)) return { rollback: { kind: "hierarchy" } as OrganizationCreateResult };
      const duplicate = await c.query("SELECT 1 FROM organizations o WHERE o.parent_org_id=$1 AND lower(o.name)=lower($2) AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id=o.id)", [parentId, name]);
      if (duplicate.rowCount) return { rollback: { kind: "name_taken" } as OrganizationCreateResult };
      const count = Number((await c.query<{ count: string }>("SELECT count(*)::text AS count FROM organizations o WHERE o.parent_org_id=$1 AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id=o.id)", [parentId])).rows[0]!.count);
      const orgId = randomUUID();
      await c.query("INSERT INTO organizations(id,name,parent_org_id) VALUES($1,$2,$3)", [orgId, name, parentId]);
      await c.query("INSERT INTO authorization_mutation_audit(request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary) VALUES($1,$2,$3,$2,$4::text[],$5::jsonb,$6::jsonb)", [requestAuditRef(`organization_create_${randomUUID()}`), principalAuditRef(principalId), ORGANIZATION_CREATE_OPERATION, [organizationAuditRef(orgId)], JSON.stringify({ childCount: count }), JSON.stringify({ childCount: count + 1 })]);
      return { kind: "created", orgId } as OrganizationCreateResult;
    });
  }

  async #transaction<T>(parentId: string, work: (c: pg.PoolClient) => Promise<T | { rollback: T }>): Promise<T> {
    const c = await this.#pool.connect(); let broken = false;
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,163))", [parentId]);
      const result = await work(c);
      if (typeof result === "object" && result !== null && "rollback" in result) { await c.query("ROLLBACK"); return (result as { rollback: T }).rollback; }
      await c.query("COMMIT"); return result as T;
    } catch (error) { try { await c.query("ROLLBACK"); } catch { broken = true; } throw error; }
    finally { c.release(broken); }
  }
}
