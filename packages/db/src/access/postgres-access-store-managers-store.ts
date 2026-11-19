import pg from "pg";

/**
 * Access lane A4 (migration 0403): the store manager grant, read by store
 * pages only. Every read joins the grant row with its store's current status
 * and its company's liveness in the same query; nothing here reads grants.
 */

export interface StoreManagerRow {
  readonly principalId: string;
  readonly storeId: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly name: string;
  readonly location: string | null;
  readonly brand: string | null;
  readonly mall: string | null;
  readonly revokedAt: string | null;
  readonly storeStatus: string;
  readonly orgLive: boolean;
}

const ROWS = `
  SELECT a.principal_id, a.store_id, a.org_id, o.name AS org_name, s.name, s.location,
         b.name AS brand, m.name AS mall, a.revoked_at, s.status AS store_status,
         NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = a.org_id) AS org_live
  FROM store_manager_access a
  JOIN organization_stores s ON s.id = a.store_id
  JOIN organizations o ON o.id = a.org_id
  LEFT JOIN catalogue_items b ON b.id = s.brand_id AND b.status = 'active'
  LEFT JOIN catalogue_items m ON m.id = s.mall_id AND m.status = 'active'
  WHERE a.principal_id = $1`;

export class PostgresAccessStoreManagersStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;

  constructor(options: { readonly pool: pg.Pool } | { readonly connectionString: string }) {
    if ("pool" in options) { this.#pool = options.pool; this.#ownsPool = false; }
    else { this.#pool = new pg.Pool({ connectionString: options.connectionString }); this.#ownsPool = true; }
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  /**
   * Every store grant row of this principal, live or not, with the store and
   * company state read now; packages/access storeAccessHolds decides. One query.
   */
  async rows(principalId: string): Promise<readonly StoreManagerRow[]> {
    const { rows } = await this.#pool.query<{
      principal_id: string; store_id: string; org_id: string; org_name: string; name: string; location: string | null;
      brand: string | null; mall: string | null; revoked_at: Date | null; store_status: string; org_live: boolean;
    }>(`${ROWS} ORDER BY lower(s.name), a.store_id, a.created_at`, [principalId]);
    return rows.map((row) => ({
      principalId: row.principal_id, storeId: row.store_id, orgId: row.org_id, orgName: row.org_name, name: row.name,
      location: row.location, brand: row.brand, mall: row.mall, revokedAt: row.revoked_at?.toISOString() ?? null,
      storeStatus: row.store_status, orgLive: row.org_live,
    }));
  }

  /**
   * The read port for other lanes (work and hours): the stores this principal
   * manages now. The same rule as storeAccessHolds, in SQL; one query.
   */
  async managedStores(principalId: string): Promise<readonly { readonly orgId: string; readonly storeId: string }[]> {
    const { rows } = await this.#pool.query<{ org_id: string; store_id: string }>(
      `SELECT a.org_id, a.store_id FROM store_manager_access a
       JOIN organization_stores s ON s.id = a.store_id AND s.status = 'active'
       WHERE a.principal_id = $1 AND a.revoked_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = a.org_id)
       ORDER BY a.org_id, a.store_id`, [principalId]);
    return rows.map((row) => ({ orgId: row.org_id, storeId: row.store_id }));
  }
}
