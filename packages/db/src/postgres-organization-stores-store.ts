import { randomUUID } from "node:crypto";
import pg from "pg";
import { databaseUrl } from "./connection.js";
import { organizationAuditRef, principalAuditRef, requestAuditRef } from "./authorization-audit.js";
import { organizationLive } from "./organization-liveness.js";

// SHU-165 O7a: owners, staff and admin keep an organization's stores; recruiters
// also read them. Every change is one transaction with one audit row carrying only
// the store count, never a store's name, location or ids.

export const ORGANIZATION_STORE_CREATE_OPERATION = "organization.store.create",
  ORGANIZATION_STORE_UPDATE_OPERATION = "organization.store.update",
  ORGANIZATION_STORE_REMOVE_OPERATION = "organization.store.remove";

type Grant = { org_id: string; role: string; scope: string };
type Decision = (rows: readonly Grant[], orgId: string, ancestors: readonly string[]) => boolean;
type Client = pg.Pool | pg.PoolClient;
export interface OrganizationStoreInput { readonly name: string; readonly location: string | null; readonly brandId: string | null; readonly mallId: string | null }
export interface OrganizationStoreRecord {
  store_id: string; name: string; location: string | null; status: string;
  brand_id: string | null; brand_name: string | null; brand_status: string | null;
  mall_id: string | null; mall_name: string | null; mall_status: string | null;
}
type ReferenceRefusal = { kind: "brand_not_found" | "mall_not_found" };
export type OrganizationStoreCreateResult = { kind: "created"; storeId: string } | { kind: "not_found" } | ReferenceRefusal;
export type OrganizationStoreUpdateResult = { kind: "updated" | "unchanged" | "not_found" | "store_not_found" } | ReferenceRefusal;
export type OrganizationStoreRemoveResult = { kind: "removed" | "not_found" | "store_not_found" };

export class PostgresOrganizationStoresStore {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(readonly options: { connectionString?: string; pool?: pg.Pool; writeDecision: Decision; readDecision: Decision }) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close() { if (this.#owns) await this.#pool.end(); }

  async #allowed(c: Client, principalId: string, orgId: string, decision: Decision, lock = false): Promise<boolean> {
    // A missing or deleted organization answers exactly as a refused one.
    if (!await organizationLive(c, orgId, lock)) return false;
    const [grants, ancestors] = await Promise.all([
      c.query<Grant>(`SELECT org_id,role,scope FROM grants WHERE principal_id=$1${lock ? " FOR SHARE" : ""}`, [principalId]),
      c.query<{ id: string }>("WITH RECURSIVE chain AS (SELECT id,parent_org_id FROM organizations WHERE id=$1 UNION ALL SELECT o.id,o.parent_org_id FROM organizations o JOIN chain c ON c.parent_org_id=o.id) SELECT id FROM chain WHERE id<>$1", [orgId]),
    ]);
    return decision(grants.rows, orgId, ancestors.rows.map((row) => row.id));
  }

  /** A brand must be an active brand this organization owns; a mall an active mall. A value the store already holds stays acceptable. */
  async #references(c: pg.PoolClient, orgId: string, input: OrganizationStoreInput, current?: { brand_id: string | null; mall_id: string | null }): Promise<ReferenceRefusal | null> {
    if (input.brandId !== null && input.brandId !== current?.brand_id) {
      const brand = await c.query("SELECT 1 FROM catalogue_items ci JOIN organization_brands ob ON ob.brand_id=ci.id WHERE ci.id=$1 AND ci.catalogue_type='brand' AND ci.status='active' AND ob.org_id=$2 FOR SHARE OF ci, ob", [input.brandId, orgId]);
      if (!brand.rows.length) return { kind: "brand_not_found" };
    }
    if (input.mallId !== null && input.mallId !== current?.mall_id) {
      const mall = await c.query("SELECT 1 FROM catalogue_items WHERE id=$1 AND catalogue_type='mall' AND status='active' FOR SHARE", [input.mallId]);
      if (!mall.rows.length) return { kind: "mall_not_found" };
    }
    return null;
  }

  async #transaction<T>(orgId: string, work: (c: pg.PoolClient) => Promise<T | { rollback: T }>): Promise<T> {
    const c = await this.#pool.connect();
    let broken = false;
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,165))", [orgId]);
      const result = await work(c);
      if (typeof result === "object" && result !== null && "rollback" in result) {
        await c.query("ROLLBACK");
        return (result as { rollback: T }).rollback;
      }
      await c.query("COMMIT");
      return result as T;
    } catch (error) {
      try { await c.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally {
      c.release(broken);
    }
  }

  async #count(c: pg.PoolClient, orgId: string): Promise<number> {
    return Number((await c.query<{ count: string }>("SELECT count(*)::text AS count FROM organization_stores WHERE org_id=$1 AND status='active'", [orgId])).rows[0]!.count);
  }

  async create(principalId: string, orgId: string, input: OrganizationStoreInput): Promise<OrganizationStoreCreateResult> {
    return this.#transaction<OrganizationStoreCreateResult>(orgId, async (c) => {
      if (!await this.#allowed(c, principalId, orgId, this.options.writeDecision, true)) return { rollback: { kind: "not_found" } };
      const refused = await this.#references(c, orgId, input);
      if (refused) return { rollback: refused };
      const count = await this.#count(c, orgId), storeId = randomUUID(), actor = principalAuditRef(principalId);
      await c.query("INSERT INTO organization_stores(id,org_id,name,location,brand_id,mall_id,created_by_ref,updated_by_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$7)", [storeId, orgId, input.name, input.location, input.brandId, input.mallId, actor]);
      await this.#audit(c, principalId, orgId, ORGANIZATION_STORE_CREATE_OPERATION, count, count + 1);
      return { kind: "created", storeId };
    });
  }

  async update(principalId: string, orgId: string, storeId: string, input: OrganizationStoreInput): Promise<OrganizationStoreUpdateResult> {
    return this.#transaction<OrganizationStoreUpdateResult>(orgId, async (c) => {
      if (!await this.#allowed(c, principalId, orgId, this.options.writeDecision, true)) return { rollback: { kind: "not_found" } };
      const current = (await c.query<{ name: string; location: string | null; brand_id: string | null; mall_id: string | null }>("SELECT name,location,brand_id,mall_id FROM organization_stores WHERE id=$1 AND org_id=$2 AND status='active' FOR UPDATE", [storeId, orgId])).rows[0];
      if (!current) return { rollback: { kind: "store_not_found" } };
      if (current.name === input.name && current.location === input.location && current.brand_id === input.brandId && current.mall_id === input.mallId) return { rollback: { kind: "unchanged" } };
      const refused = await this.#references(c, orgId, input, current);
      if (refused) return { rollback: refused };
      const count = await this.#count(c, orgId);
      await c.query("UPDATE organization_stores SET name=$3,location=$4,brand_id=$5,mall_id=$6,updated_by_ref=$7,updated_at=clock_timestamp() WHERE id=$1 AND org_id=$2", [storeId, orgId, input.name, input.location, input.brandId, input.mallId, principalAuditRef(principalId)]);
      await this.#audit(c, principalId, orgId, ORGANIZATION_STORE_UPDATE_OPERATION, count, count);
      return { kind: "updated" };
    });
  }

  async remove(principalId: string, orgId: string, storeId: string): Promise<OrganizationStoreRemoveResult> {
    return this.#transaction<OrganizationStoreRemoveResult>(orgId, async (c) => {
      if (!await this.#allowed(c, principalId, orgId, this.options.writeDecision, true)) return { rollback: { kind: "not_found" } };
      const current = await c.query("SELECT 1 FROM organization_stores WHERE id=$1 AND org_id=$2 AND status='active' FOR UPDATE", [storeId, orgId]);
      if (!current.rows.length) return { rollback: { kind: "store_not_found" } };
      const count = await this.#count(c, orgId);
      await c.query("UPDATE organization_stores SET status='deleted',deleted_at=clock_timestamp(),updated_by_ref=$3,updated_at=clock_timestamp() WHERE id=$1 AND org_id=$2", [storeId, orgId, principalAuditRef(principalId)]);
      await this.#audit(c, principalId, orgId, ORGANIZATION_STORE_REMOVE_OPERATION, count, count - 1);
      return { kind: "removed" };
    });
  }

  /** Active stores of the organization, or null when the reader is refused (or the organization is unknown or deleted). */
  async list(principalId: string, orgId: string): Promise<OrganizationStoreRecord[] | null> {
    if (!await this.#allowed(this.#pool, principalId, orgId, this.options.readDecision)) return null;
    return (await this.#pool.query<OrganizationStoreRecord>(
      "SELECT s.id AS store_id,s.name,s.location,s.status,s.brand_id,b.name AS brand_name,b.status AS brand_status,s.mall_id,m.name AS mall_name,m.status AS mall_status FROM organization_stores s LEFT JOIN catalogue_items b ON b.id=s.brand_id LEFT JOIN catalogue_items m ON m.id=s.mall_id WHERE s.org_id=$1 AND s.status='active'",
      [orgId],
    )).rows;
  }

  async #audit(c: pg.PoolClient, principalId: string, orgId: string, operation: string, before: number, after: number) {
    await c.query(
      "INSERT INTO authorization_mutation_audit(request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary) VALUES($1,$2,$3,$2,$4::text[],$5::jsonb,$6::jsonb)",
      [requestAuditRef(`organization_store_${randomUUID()}`), principalAuditRef(principalId), operation, [organizationAuditRef(orgId)], JSON.stringify({ storeCount: before }), JSON.stringify({ storeCount: after })],
    );
  }
}
