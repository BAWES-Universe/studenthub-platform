// Cutover lane M-4: legacy brand company links become organization brands (migration 0200), and
// legacy stores become organization stores (migration 0202). Same contract as the catalogue and
// organization imports: keyed by legacy id in legacy_id_maps, a same-digest re-run is unchanged,
// a changed row is a conflict carrying both digests and is never overwritten, each row runs in its
// own savepoint, one batch is one transaction, and batches are serialized with a transaction
// advisory lock.
// Companies and catalogues import first: a row whose company, brand or mall has no id map row is
// refused, and so is a store whose brand is not linked to the store's own organization (the stores
// screen allows only those). A brand already linked to another organization is refused, never moved.
// Results carry legacy ids, refusal codes and digests only.

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";

export interface BrandLinkImportRow {
  readonly brandLegacyId: string;
  readonly companyLegacyId: string;
  readonly digest: string;
}

export interface StoreImportRow {
  readonly legacyId: string;
  readonly companyLegacyId: string;
  readonly name: string;
  readonly location: string | null;
  readonly brandLegacyId: string | null;
  readonly mallLegacyId: string | null;
  readonly status: "active" | "deleted";
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly digest: string;
}

export type BrandLinkImportRefusal = "no_brand" | "no_organization" | "brand_taken" | "invalid";
export type StoreImportRefusal = "no_organization" | "no_brand" | "brand_not_linked" | "no_mall" | "invalid";

export interface StoreImportResult<Refusal extends string> {
  readonly inserted: number;
  readonly adopted: number;
  readonly unchanged: number;
  readonly conflicts: readonly { readonly legacyId: string; readonly existingDigest: string; readonly incomingDigest: string }[];
  readonly refused: readonly { readonly legacyId: string; readonly code: Refusal }[];
}

export interface StoreReconciliation {
  readonly legacyTable: string;
  readonly legacy: number;
  readonly imported: number;
  readonly adopted: number;
  readonly skipped: readonly string[];
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

const LINK_TABLE = "brand_company";
const LINK_ENTITY = "organization_brand";
const STORE_TABLE = "store";
const STORE_ENTITY = "organization_store";
const TABLES = { [LINK_TABLE]: LINK_ENTITY, [STORE_TABLE]: STORE_ENTITY } as const;
const isRuleRefusal = (e: unknown) => ["23514", "23503", "23505", "22P02", "22007", "22008"].includes((e as { code?: string }).code ?? "");

type Outcome<R> = "inserted" | "adopted" | "unchanged" | { refused: R } | { existing: string };

class Tally<R extends string> {
  inserted = 0; adopted = 0; unchanged = 0;
  conflicts: { legacyId: string; existingDigest: string; incomingDigest: string }[] = [];
  refused: { legacyId: string; code: R }[] = [];
  add(legacyId: string, digest: string, outcome: Outcome<R>): void {
    if (outcome === "inserted") this.inserted++;
    else if (outcome === "adopted") this.adopted++;
    else if (outcome === "unchanged") this.unchanged++;
    else if ("refused" in outcome) this.refused.push({ legacyId, code: outcome.refused });
    else this.conflicts.push({ legacyId, existingDigest: outcome.existing, incomingDigest: digest });
  }
  result(): StoreImportResult<R> {
    return Object.freeze({ inserted: this.inserted, adopted: this.adopted, unchanged: this.unchanged,
      conflicts: Object.freeze(this.conflicts), refused: Object.freeze(this.refused) });
  }
}

export class PostgresStoreImportStore {
  readonly #pool: PgPool;
  readonly #owns: boolean;
  /** @param actorRef sha256 hex recorded as linked_by_ref, created_by_ref and updated_by_ref on imported rows. */
  constructor(poolOrConfig: PgPool | PoolConfig, private readonly actorRef: string) {
    if (!/^[0-9a-f]{64}$/.test(actorRef)) throw new Error("actorRef must be sha256 hex");
    this.#pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#owns = !(poolOrConfig instanceof pg.Pool);
  }

  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  async importBrandLinks(links: readonly BrandLinkImportRow[]): Promise<StoreImportResult<BrandLinkImportRefusal>> {
    return this.#batch("legacy-import:brand-link", links, (row) => row.brandLegacyId, (client, row) => this.#linkOne(client, row));
  }

  /** Imports one batch of stores; `now` stands in for timestamps legacy does not hold. */
  async importStores(rows: readonly StoreImportRow[], now: string): Promise<StoreImportResult<StoreImportRefusal>> {
    return this.#batch("legacy-import:store", rows, (row) => row.legacyId, (client, row) => this.#storeOne(client, row, now));
  }

  async #batch<T extends { readonly digest: string }, R extends string>(lock: string, rows: readonly T[], idOf: (row: T) => string,
    one: (client: PoolClient, row: T) => Promise<Outcome<R>>): Promise<StoreImportResult<R>> {
    const tally = new Tally<R>();
    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      // One import batch at a time: without this, two runs could both find no map row for the
      // same legacy id, and the one that commits second would misreport the row as refused.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lock]);
      for (const row of rows) {
        await client.query("SAVEPOINT store_import");
        try {
          tally.add(idOf(row), row.digest, await one(client, row));
          await client.query("RELEASE SAVEPOINT store_import");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT store_import");
          await client.query("RELEASE SAVEPOINT store_import");
          if (!isRuleRefusal(error)) throw error;
          tally.refused.push({ legacyId: idOf(row), code: "invalid" as R });
        }
      }
      await client.query("COMMIT");
      return tally.result();
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async #held(client: PoolClient, table: string, legacyId: string, digest: string): Promise<Outcome<never> | null> {
    const { rows: [held] } = await client.query<{ digest: string }>(
      "SELECT digest FROM legacy_id_maps WHERE legacy_table = $1 AND legacy_id = $2 FOR UPDATE", [table, legacyId]);
    if (!held) return null;
    return held.digest === digest ? "unchanged" : { existing: held.digest };
  }

  async #mapped(client: PoolClient, table: string, entity: string, legacyId: string): Promise<string | null> {
    const { rows: [row] } = await client.query<{ platform_id: string }>(
      "SELECT platform_id FROM legacy_id_maps WHERE legacy_table = $1 AND legacy_id = $2 AND entity = $3", [table, legacyId, entity]);
    return row?.platform_id ?? null;
  }

  async #map(client: PoolClient, table: string, legacyId: string, platformId: string, outcome: "imported" | "adopted", digest: string): Promise<void> {
    await client.query(
      "INSERT INTO legacy_id_maps (legacy_table, legacy_id, entity, platform_id, outcome, digest) VALUES ($1, $2, $3, $4, $5, $6)",
      [table, legacyId, TABLES[table as keyof typeof TABLES], platformId, outcome, digest]);
  }

  async #linkOne(client: PoolClient, row: BrandLinkImportRow): Promise<Outcome<BrandLinkImportRefusal>> {
    const held = await this.#held(client, LINK_TABLE, row.brandLegacyId, row.digest);
    if (held) return held;
    const brandId = await this.#mapped(client, "brand", "catalogue_item", row.brandLegacyId);
    if (brandId === null) return { refused: "no_brand" };
    const orgId = await this.#mapped(client, "company", "organization", row.companyLegacyId);
    if (orgId === null) return { refused: "no_organization" };
    // The brands screen links under this per-organization lock; take it too so an app link or
    // unlink of the same organization waits for this batch.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 325))", [orgId]);
    const { rows: [current] } = await client.query<{ org_id: string }>(
      "SELECT org_id FROM organization_brands WHERE brand_id = $1::uuid FOR UPDATE", [brandId]);
    if (current) {
      // Two legacy brands with the same name share one catalogue item; only one company keeps it.
      if (current.org_id !== orgId) return { refused: "brand_taken" };
      await this.#map(client, LINK_TABLE, row.brandLegacyId, brandId, "adopted", row.digest);
      return "adopted";
    }
    await client.query("INSERT INTO organization_brands (brand_id, org_id, linked_by_ref) VALUES ($1, $2, $3)", [brandId, orgId, this.actorRef]);
    await this.#map(client, LINK_TABLE, row.brandLegacyId, brandId, "imported", row.digest);
    return "inserted";
  }

  async #storeOne(client: PoolClient, row: StoreImportRow, now: string): Promise<Outcome<StoreImportRefusal>> {
    const held = await this.#held(client, STORE_TABLE, row.legacyId, row.digest);
    if (held) return held;
    const orgId = await this.#mapped(client, "company", "organization", row.companyLegacyId);
    if (orgId === null) return { refused: "no_organization" };
    let brandId: string | null = null;
    if (row.brandLegacyId !== null) {
      brandId = await this.#mapped(client, "brand", "catalogue_item", row.brandLegacyId);
      if (brandId === null) return { refused: "no_brand" };
      // Held until the batch commits, so an unlink cannot slip in before the store names the brand.
      const { rows: linked } = await client.query(
        "SELECT 1 FROM organization_brands WHERE brand_id = $1::uuid AND org_id = $2 FOR SHARE", [brandId, orgId]);
      if (linked.length === 0) return { refused: "brand_not_linked" };
    }
    let mallId: string | null = null;
    if (row.mallLegacyId !== null) {
      mallId = await this.#mapped(client, "mall", "catalogue_item", row.mallLegacyId);
      if (mallId === null) return { refused: "no_mall" };
    }
    const id = randomUUID();
    const createdAt = row.createdAt ?? now;
    const updatedAt = row.updatedAt ?? createdAt;
    await client.query(
      `INSERT INTO organization_stores (id, org_id, name, location, brand_id, mall_id, status, created_by_ref, updated_by_ref, created_at, updated_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11)`,
      [id, orgId, row.name, row.location, brandId, mallId, row.status, this.actorRef, createdAt, updatedAt, row.status === "deleted" ? updatedAt : null]);
    await this.#map(client, STORE_TABLE, row.legacyId, id, "imported", row.digest);
    return "inserted";
  }

  /** The platform store id for each mapped legacy store id (for later domains: assignments, work). */
  async storeIdMap(): Promise<ReadonlyMap<string, string>> {
    const { rows } = await this.#pool.query<{ legacy_id: string; platform_id: string }>(
      "SELECT legacy_id, platform_id FROM legacy_id_maps WHERE legacy_table = $1 AND entity = $2", [STORE_TABLE, STORE_ENTITY]);
    return new Map(rows.map((r) => [r.legacy_id, r.platform_id]));
  }

  /** Legacy brand or store ids against the id map; reported skips listed apart from unexplained gaps. */
  async reconcile(legacyTable: "brand_company" | "store", legacyIds: readonly string[], reportedIds: readonly string[] = []): Promise<StoreReconciliation> {
    const { rows } = await this.#pool.query<{ legacy_id: string; outcome: string }>(
      "SELECT legacy_id, outcome FROM legacy_id_maps WHERE legacy_table = $1 AND entity = $2", [legacyTable, TABLES[legacyTable]]);
    const mapped = new Map(rows.map((r) => [r.legacy_id, r.outcome]));
    const source = new Set(legacyIds);
    const reported = new Set(reportedIds);
    const absent = [...source].filter((id) => !mapped.has(id)).sort();
    const count = (outcome: string) => [...mapped].filter(([id, o]) => o === outcome && source.has(id)).length;
    return Object.freeze({
      legacyTable,
      legacy: source.size,
      imported: count("imported"),
      adopted: count("adopted"),
      skipped: Object.freeze(absent.filter((id) => reported.has(id))),
      missing: Object.freeze(absent.filter((id) => !reported.has(id))),
      extra: Object.freeze([...mapped.keys()].filter((id) => !source.has(id)).sort()),
    });
  }
}
