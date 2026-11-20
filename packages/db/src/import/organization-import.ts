// Cutover lane M-4: imported legacy companies become organizations with their approved snapshot.
// Same contract as the catalogue import: keyed by legacy id in legacy_id_maps, a same-digest
// re-run is unchanged, a changed row is a conflict carrying both digests and is never
// overwritten, each row runs in its own savepoint, one batch is one transaction, and batches
// are serialized with a transaction advisory lock.
// Rows arrive parents first; a row whose parent is not in the id map is refused.
// Results carry legacy ids, refusal codes and digests only.

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";

export interface OrganizationImportRow {
  readonly legacyId: string;
  readonly parentLegacyId: string | null;
  readonly name: string;
  readonly snapshot: Readonly<Record<string, string | number | boolean | null>>;
  readonly digest: string;
}

export type OrganizationImportRefusal = "no_parent" | "invalid";

export interface OrganizationImportResult {
  readonly inserted: number;
  readonly unchanged: number;
  readonly conflicts: readonly { readonly legacyId: string; readonly existingDigest: string; readonly incomingDigest: string }[];
  readonly refused: readonly { readonly legacyId: string; readonly code: OrganizationImportRefusal }[];
}

/** Matches @studenthub/organizations ApprovedOrganizationSnapshot structurally. */
export type ImportedOrganizationSnapshot =
  | { readonly kind: "unconfigured" }
  | { readonly kind: "missing" }
  | { readonly kind: "found"; readonly row: unknown };

const LEGACY_TABLE = "company";
const ENTITY = "organization";
const isRuleRefusal = (e: unknown) => ["23514", "23503", "23505", "22P02"].includes((e as { code?: string }).code ?? "");

export class PostgresOrganizationImportStore {
  readonly #pool: PgPool;
  readonly #owns: boolean;
  /**
   * @param sourceRevision the legacy revision the organization projections were proven against.
   * @param operatorOrgId the operator organization top-level companies hang under in the registry,
   *   as company registration approval does (the first operator organization).
   */
  constructor(poolOrConfig: PgPool | PoolConfig, private readonly sourceRevision: string, private readonly operatorOrgId: string) {
    if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error("sourceRevision must be a 40-hex revision");
    if (operatorOrgId.length === 0) throw new Error("operatorOrgId is required");
    this.#pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#owns = !(poolOrConfig instanceof pg.Pool);
  }

  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  async importOrganizations(rows: readonly OrganizationImportRow[]): Promise<OrganizationImportResult> {
    let inserted = 0, unchanged = 0;
    const conflicts: { legacyId: string; existingDigest: string; incomingDigest: string }[] = [];
    const refused: { legacyId: string; code: OrganizationImportRefusal }[] = [];
    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      // One import batch at a time: without this, two runs could both find no map row for the
      // same legacy id, and the one that commits second would misreport the row as refused.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('legacy-import:organization', 0))");
      for (const row of rows) {
        await client.query("SAVEPOINT organization_import");
        try {
          const outcome = await this.#importOne(client, row);
          if (outcome === "inserted") inserted++;
          else if (outcome === "unchanged") unchanged++;
          else if (outcome === "no_parent") refused.push({ legacyId: row.legacyId, code: "no_parent" });
          else conflicts.push({ legacyId: row.legacyId, existingDigest: outcome.existing, incomingDigest: row.digest });
          await client.query("RELEASE SAVEPOINT organization_import");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT organization_import");
          await client.query("RELEASE SAVEPOINT organization_import");
          if (!isRuleRefusal(error)) throw error;
          refused.push({ legacyId: row.legacyId, code: "invalid" });
        }
      }
      await client.query("COMMIT");
      return Object.freeze({ inserted, unchanged, conflicts: Object.freeze(conflicts), refused: Object.freeze(refused) });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async #importOne(client: PoolClient, row: OrganizationImportRow): Promise<"inserted" | "unchanged" | "no_parent" | { existing: string }> {
    const { rows: held } = await client.query<{ digest: string }>(
      "SELECT digest FROM legacy_id_maps WHERE legacy_table = $1 AND legacy_id = $2 FOR UPDATE", [LEGACY_TABLE, row.legacyId]);
    if (held[0]) return held[0].digest === row.digest ? "unchanged" : { existing: held[0].digest };
    let parentOrgId: string | null = null;
    if (row.parentLegacyId !== null) {
      const { rows: parent } = await client.query<{ platform_id: string }>(
        "SELECT platform_id FROM legacy_id_maps WHERE legacy_table = $1 AND legacy_id = $2", [LEGACY_TABLE, row.parentLegacyId]);
      if (!parent[0]) return "no_parent";
      parentOrgId = parent[0].platform_id;
    }
    const orgId = randomUUID();
    await client.query("INSERT INTO organizations (id, name, parent_org_id) VALUES ($1, $2, $3)", [orgId, row.name, parentOrgId ?? this.operatorOrgId]);
    await client.query("INSERT INTO legacy_company_snapshots (org_id, parent_org_id, snapshot, source_revision) VALUES ($1, $2, $3::jsonb, $4)",
      [orgId, parentOrgId, JSON.stringify(row.snapshot), this.sourceRevision]);
    await client.query(
      "INSERT INTO legacy_id_maps (legacy_table, legacy_id, entity, platform_id, outcome, digest) VALUES ($1, $2, $3, $4, 'imported', $5)",
      [LEGACY_TABLE, row.legacyId, ENTITY, orgId, row.digest]);
    return "inserted";
  }

  /** The platform organization id for each mapped legacy company id. */
  async idMap(): Promise<ReadonlyMap<string, string>> {
    const { rows } = await this.#pool.query<{ legacy_id: string; platform_id: string }>(
      "SELECT legacy_id, platform_id FROM legacy_id_maps WHERE legacy_table = $1 AND entity = $2", [LEGACY_TABLE, ENTITY]);
    return new Map(rows.map((r) => [r.legacy_id, r.platform_id]));
  }

  /** Legacy company ids against the id map; reported skips listed apart from unexplained gaps. */
  async reconcile(legacyIds: readonly string[], reportedIds: readonly string[] = []) {
    const map = await this.idMap();
    const source = new Set(legacyIds);
    const reported = new Set(reportedIds);
    const absent = [...source].filter((id) => !map.has(id)).sort();
    return Object.freeze({
      legacyTable: LEGACY_TABLE,
      legacy: source.size,
      imported: [...map.keys()].filter((id) => source.has(id)).length,
      skipped: Object.freeze(absent.filter((id) => reported.has(id))),
      missing: Object.freeze(absent.filter((id) => !reported.has(id))),
      extra: Object.freeze([...map.keys()].filter((id) => !source.has(id)).sort()),
    });
  }
}

/**
 * The approved-data source for @studenthub/organizations (ApprovedOrganizationAdapter): the
 * imported snapshot with its organization id, its company parent (null for a top-level company,
 * matching companyParentOf), the import time and the source revision.
 * An organization without an imported snapshot (created in the platform) is "missing".
 */
export class PostgresImportedOrganizationSnapshots {
  readonly #pool: PgPool;
  constructor(pool: PgPool) { this.#pool = pool; }

  async readSnapshot(orgId: string): Promise<ImportedOrganizationSnapshot> {
    return (await this.readSnapshots([orgId])).get(orgId) ?? { kind: "missing" };
  }

  async readSnapshots(orgIds: readonly string[]): Promise<ReadonlyMap<string, ImportedOrganizationSnapshot>> {
    const result = new Map<string, ImportedOrganizationSnapshot>(orgIds.map((id) => [id, { kind: "missing" }]));
    if (orgIds.length === 0) return result;
    const { rows } = await this.#pool.query<{ id: string; parent_org_id: string | null; snapshot: Record<string, unknown>; source_revision: string; imported_at: Date }>(
      `SELECT s.org_id AS id, s.parent_org_id, s.snapshot, s.source_revision, s.imported_at
         FROM legacy_company_snapshots s
        WHERE s.org_id = ANY($1::text[])`, [[...new Set(orgIds)]]);
    for (const r of rows) {
      result.set(r.id, Object.freeze({ kind: "found", row: Object.freeze({
        ...r.snapshot, org_id: r.id, parent_org_id: r.parent_org_id,
        imported_at: r.imported_at.toISOString(), source_revision: r.source_revision,
      }) }));
    }
    return result;
  }
}
