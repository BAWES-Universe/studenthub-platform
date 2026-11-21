// Cutover lane M-4: writes mapped legacy catalogue rows and their id maps.
// Contract (the same as the work lane's import store):
// - keyed by (legacy table, legacy id) in legacy_id_maps; a re-run with the same digest
//   writes nothing (unchanged); a held id with a different digest is a conflict carrying
//   both digests, never an overwrite;
// - a row merged into another legacy row maps to that row's item, so it needs that row
//   imported first (the importer sends rows in legacy id order, and the target sorts first);
// - an active legacy row whose kind and normalized name match an active platform item that
//   no legacy row holds yet is adopted: the map points at that item and nothing is written.
//   A currency or bank is adopted only when its code and typed details are the same as the
//   item's (details on one side only are not the same); otherwise it is refused as
//   name_conflict, nothing is written or mapped, and a re-run refuses it again. The same check
//   holds a merged currency or bank row whose target's item differs from it (say, the target
//   row changed in legacy and its item kept the first import). Any merged row is held the same
//   way unless its target's stored item is active and of the same kind and normalized name;
// - each row runs in its own savepoint and one batch is one transaction.
// Results carry legacy ids, rule codes and digests only.

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";

export interface CatalogueImportRow {
  readonly legacyTable: string;
  readonly legacyId: string;
  readonly type: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly code: string | null;
  readonly status: "active" | "deleted";
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly currency: { readonly symbol: string; readonly decimalPlaces: number } | null;
  readonly bank: { readonly swiftCode: string; readonly ibanBankCode: string; readonly abkCode: string; readonly transferType: string } | null;
  readonly mergedInto: string | null;
  readonly digest: string;
}

export type CatalogueImportRefusal = "no_merge_target" | "name_conflict" | "invalid";

export interface CatalogueImportResult {
  readonly inserted: number;
  readonly merged: number;
  readonly adopted: number;
  readonly unchanged: number;
  readonly conflicts: readonly { readonly legacyTable: string; readonly legacyId: string; readonly existingDigest: string; readonly incomingDigest: string }[];
  readonly refused: readonly { readonly legacyTable: string; readonly legacyId: string; readonly code: CatalogueImportRefusal }[];
}

export interface CatalogueReconciliation {
  readonly legacyTable: string;
  /** Legacy ids the mirror holds. */
  readonly legacy: number;
  /** Of those, how many have an id map row. */
  readonly mapped: number;
  /** Mapped rows by outcome. */
  readonly imported: number;
  readonly merged: number;
  readonly adopted: number;
  /** Legacy ids the importer reported and skipped (passed in), absent from the map. */
  readonly skipped: readonly string[];
  /** Legacy ids with no map row and no reported reason. */
  readonly missing: readonly string[];
  /** Map rows for ids the mirror no longer holds. */
  readonly extra: readonly string[];
}

const ENTITY = "catalogue_item";

class Tally {
  inserted = 0; merged = 0; adopted = 0; unchanged = 0;
  conflicts: { legacyTable: string; legacyId: string; existingDigest: string; incomingDigest: string }[] = [];
  refused: { legacyTable: string; legacyId: string; code: CatalogueImportRefusal }[] = [];
  result(): CatalogueImportResult {
    return Object.freeze({ inserted: this.inserted, merged: this.merged, adopted: this.adopted, unchanged: this.unchanged,
      conflicts: Object.freeze(this.conflicts), refused: Object.freeze(this.refused) });
  }
}

const isRuleRefusal = (e: unknown) => ["23514", "23503", "23505", "22P02", "22007", "22008"].includes((e as { code?: string }).code ?? "");

export class PostgresCatalogueImportStore {
  readonly #pool: PgPool;
  readonly #owns: boolean;
  /** @param actorRef sha256 hex recorded as created_by_ref/updated_by_ref on imported rows. */
  constructor(poolOrConfig: PgPool | PoolConfig, private readonly actorRef: string) {
    if (!/^[0-9a-f]{64}$/.test(actorRef)) throw new Error("actorRef must be sha256 hex");
    this.#pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#owns = !(poolOrConfig instanceof pg.Pool);
  }

  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /** Imports one batch; `now` stands in for timestamps legacy does not hold. */
  async importItems(rows: readonly CatalogueImportRow[], now: string): Promise<CatalogueImportResult> {
    const tally = new Tally();
    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      // One import batch at a time: without this, two runs could both find no map row for the
      // same legacy id, and the one that commits second would misreport the row as refused.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('legacy-import:catalogue', 0))");
      for (const row of rows) {
        await client.query("SAVEPOINT catalogue_import");
        try {
          await this.#importOne(client, row, now, tally);
          await client.query("RELEASE SAVEPOINT catalogue_import");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT catalogue_import");
          await client.query("RELEASE SAVEPOINT catalogue_import");
          if (!isRuleRefusal(error)) throw error;
          tally.refused.push({ legacyTable: row.legacyTable, legacyId: row.legacyId, code: "invalid" });
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

  async #importOne(client: PoolClient, row: CatalogueImportRow, now: string, tally: Tally): Promise<void> {
    const { rows: held } = await client.query<{ digest: string }>(
      "SELECT digest FROM legacy_id_maps WHERE legacy_table = $1 AND legacy_id = $2 FOR UPDATE", [row.legacyTable, row.legacyId]);
    if (held[0]) {
      if (held[0].digest === row.digest) tally.unchanged++;
      else tally.conflicts.push({ legacyTable: row.legacyTable, legacyId: row.legacyId, existingDigest: held[0].digest, incomingDigest: row.digest });
      return;
    }

    if (row.mergedInto !== null) {
      const { rows: target } = await client.query<{ platform_id: string }>(
        "SELECT platform_id FROM legacy_id_maps WHERE legacy_table = $1 AND legacy_id = $2", [row.legacyTable, row.mergedInto]);
      if (!target[0]) { tally.refused.push({ legacyTable: row.legacyTable, legacyId: row.legacyId, code: "no_merge_target" }); return; }
      // A merge joins an active row to the active item of the same kind and name. The target's
      // item, as stored, may no longer be that (a digest conflict keeps a deleted or renamed item),
      // so the alias is held by its legacy id rather than mapped to it. The row stays locked until
      // the batch commits, so an app rename, delete or details write cannot slip in before the map.
      const { rows: [item] } = await client.query<{ id: string }>(
        `SELECT id::text FROM catalogue_items WHERE id = $1::uuid AND status = 'active' AND catalogue_type = $2 AND normalized_name = $3
          FOR UPDATE`,
        [target[0].platform_id, row.type, row.normalizedName]);
      if (!item) { tally.refused.push({ legacyTable: row.legacyTable, legacyId: row.legacyId, code: "name_conflict" }); return; }
      // The target's item may hold older content than this batch's target row (a digest conflict
      // keeps it), so a currency or bank alias is checked against the item itself.
      if (!(await this.#sameTypedContent(client, row, target[0].platform_id))) {
        tally.refused.push({ legacyTable: row.legacyTable, legacyId: row.legacyId, code: "name_conflict" });
        return;
      }
      await this.#map(client, row, target[0].platform_id, "merged");
      tally.merged++;
      return;
    }

    if (row.status === "active") {
      const { rows: existing } = await client.query<{ id: string }>(
        `SELECT i.id::text FROM catalogue_items i
          WHERE i.catalogue_type = $1 AND i.normalized_name = $2 AND i.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM legacy_id_maps m WHERE m.entity = $3 AND m.platform_id = i.id::text)
          FOR UPDATE OF i`,
        [row.type, row.normalizedName, ENTITY]);
      if (existing[0]) {
        if (!(await this.#sameTypedContent(client, row, existing[0].id))) {
          tally.refused.push({ legacyTable: row.legacyTable, legacyId: row.legacyId, code: "name_conflict" });
          return;
        }
        await this.#map(client, row, existing[0].id, "adopted");
        tally.adopted++;
        return;
      }
    }

    const id = randomUUID();
    const createdAt = row.createdAt ?? now;
    const updatedAt = row.updatedAt ?? createdAt;
    await client.query(
      `INSERT INTO catalogue_items (id, catalogue_type, name, normalized_name, code, status, created_by_ref, updated_by_ref, created_at, updated_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10)`,
      [id, row.type, row.name, row.normalizedName, row.code, row.status, this.actorRef, createdAt, updatedAt, row.status === "deleted" ? updatedAt : null]);
    if (row.currency) {
      await client.query(
        `INSERT INTO catalogue_currency_details (currency_id, symbol, decimal_places, created_by_ref, updated_by_ref, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4, $5, $6)`,
        [id, row.currency.symbol, row.currency.decimalPlaces, this.actorRef, createdAt, updatedAt]);
    }
    if (row.bank) {
      await client.query(
        `INSERT INTO catalogue_bank_payment_details (bank_id, swift_code, iban_bank_code, abk_code, transfer_type, created_by_ref, updated_by_ref, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)`,
        [id, row.bank.swiftCode, row.bank.ibanBankCode, row.bank.abkCode, row.bank.transferType, this.actorRef, createdAt, updatedAt]);
    }
    await this.#map(client, row, id, "imported");
    tally.inserted++;
  }

  /**
   * For a currency or bank: the item's code and typed details equal the row's. Other kinds carry
   * none. The caller holds the item row FOR UPDATE, which also blocks a details insert (its
   * foreign-key check needs a key-share lock on the item); existing details rows are read FOR
   * SHARE, so a concurrent details update waits for this batch to commit.
   */
  async #sameTypedContent(client: PoolClient, row: CatalogueImportRow, itemId: string): Promise<boolean> {
    if (row.type !== "currency" && row.type !== "bank") return true;
    const { rows: [item] } = await client.query<{ code: string | null }>("SELECT code FROM catalogue_items WHERE id = $1::uuid", [itemId]);
    if (!item || (item.code ?? null) !== row.code) return false;
    const { rows: [c] } = await client.query<{ symbol: string; decimal_places: number }>(
      "SELECT symbol, decimal_places FROM catalogue_currency_details WHERE currency_id = $1::uuid FOR SHARE", [itemId]);
    const { rows: [b] } = await client.query<{ swift_code: string; iban_bank_code: string; abk_code: string; transfer_type: string }>(
      "SELECT swift_code, iban_bank_code, abk_code, transfer_type FROM catalogue_bank_payment_details WHERE bank_id = $1::uuid FOR SHARE", [itemId]);
    const currency = c ? { symbol: c.symbol, decimalPlaces: Number(c.decimal_places) } : null;
    const bank = b ? { swiftCode: b.swift_code, ibanBankCode: b.iban_bank_code, abkCode: b.abk_code, transferType: b.transfer_type } : null;
    const same = (x: object | null, y: object | null) => x === null || y === null ? x === y
      : JSON.stringify(Object.entries(x).sort()) === JSON.stringify(Object.entries(y).sort());
    return same(currency, row.currency) && same(bank, row.bank);
  }

  async #map(client: PoolClient, row: CatalogueImportRow, platformId: string, outcome: "imported" | "merged" | "adopted"): Promise<void> {
    await client.query(
      "INSERT INTO legacy_id_maps (legacy_table, legacy_id, entity, platform_id, outcome, digest) VALUES ($1, $2, $3, $4, $5, $6)",
      [row.legacyTable, row.legacyId, ENTITY, platformId, outcome, row.digest]);
  }

  /** The platform item id for each mapped legacy id of one table (for later domains: brands, malls, areas). */
  async idMap(legacyTable: string): Promise<ReadonlyMap<string, string>> {
    const { rows } = await this.#pool.query<{ legacy_id: string; platform_id: string }>(
      "SELECT legacy_id, platform_id FROM legacy_id_maps WHERE legacy_table = $1 AND entity = $2", [legacyTable, ENTITY]);
    return new Map(rows.map((r) => [r.legacy_id, r.platform_id]));
  }

  /** Per-table reconciliation of the mirror's ids against the id map. */
  async reconcile(legacyTable: string, legacyIds: readonly string[], reportedIds: readonly string[] = []): Promise<CatalogueReconciliation> {
    const { rows } = await this.#pool.query<{ legacy_id: string; outcome: "imported" | "merged" | "adopted" }>(
      "SELECT legacy_id, outcome FROM legacy_id_maps WHERE legacy_table = $1 AND entity = $2", [legacyTable, ENTITY]);
    const mapped = new Map(rows.map((r) => [r.legacy_id, r.outcome]));
    const source = new Set(legacyIds);
    const reported = new Set(reportedIds);
    const absent = [...source].filter((id) => !mapped.has(id)).sort();
    const count = (outcome: string) => [...mapped].filter(([id, o]) => o === outcome && source.has(id)).length;
    return Object.freeze({
      legacyTable,
      legacy: source.size,
      mapped: [...mapped.keys()].filter((id) => source.has(id)).length,
      imported: count("imported"),
      merged: count("merged"),
      adopted: count("adopted"),
      skipped: Object.freeze(absent.filter((id) => reported.has(id))),
      missing: Object.freeze(absent.filter((id) => !reported.has(id))),
      extra: Object.freeze([...mapped.keys()].filter((id) => !source.has(id)).sort()),
    });
  }
}
