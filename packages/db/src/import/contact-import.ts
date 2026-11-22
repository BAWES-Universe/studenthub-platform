// Cutover lane M-4: legacy company links without access become company contacts (migration 0402)
// with their phones and email addresses. Same contract as the other M-4 imports: keyed by legacy
// id in legacy_id_maps, a same-digest re-run is unchanged, a changed row is a conflict carrying
// both digests and is never overwritten, each row runs in its own savepoint, one batch is one
// transaction, and batches are serialized with a transaction advisory lock.
// Companies import first: a row whose company has no id map row is refused. A contact removed in
// legacy imports as removed. Results carry legacy ids, refusal codes and digests only.

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";

export interface ContactImportRow {
  readonly legacyId: string;
  readonly companyLegacyId: string;
  readonly name: string;
  readonly roleTitle: string | null;
  readonly phones: readonly string[];
  readonly emails: readonly string[];
  readonly removed: boolean;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly digest: string;
}

export type ContactImportRefusal = "no_organization" | "invalid";

export interface ContactImportResult {
  readonly inserted: number;
  readonly unchanged: number;
  readonly conflicts: readonly { readonly legacyId: string; readonly existingDigest: string; readonly incomingDigest: string }[];
  readonly refused: readonly { readonly legacyId: string; readonly code: ContactImportRefusal }[];
}

const LEGACY_TABLE = "company_contact";
const ENTITY = "company_contact";
// The contacts screen's company lock (PostgresAccessContactsStore): an app write to the same
// company waits for this batch.
const ORG_LOCK_KEY = 5960;
const isRuleRefusal = (e: unknown) => ["23514", "23503", "23505", "22P02", "22007", "22008"].includes((e as { code?: string }).code ?? "");

export class PostgresContactImportStore {
  readonly #pool: PgPool;
  readonly #owns: boolean;
  /** @param actorRef sha256 hex recorded as created_by, updated_by and removed_by on imported rows. */
  constructor(poolOrConfig: PgPool | PoolConfig, private readonly actorRef: string) {
    if (!/^[0-9a-f]{64}$/.test(actorRef)) throw new Error("actorRef must be sha256 hex");
    this.#pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#owns = !(poolOrConfig instanceof pg.Pool);
  }

  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /** Imports one batch; `now` stands in for timestamps legacy does not hold. */
  async importContacts(rows: readonly ContactImportRow[], now: string): Promise<ContactImportResult> {
    let inserted = 0, unchanged = 0;
    const conflicts: { legacyId: string; existingDigest: string; incomingDigest: string }[] = [];
    const refused: { legacyId: string; code: ContactImportRefusal }[] = [];
    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      // One import batch at a time: without this, two runs could both find no map row for the
      // same legacy id, and the one that commits second would misreport the row as refused.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('legacy-import:company-contact', 0))");
      for (const row of rows) {
        await client.query("SAVEPOINT contact_import");
        try {
          const outcome = await this.#importOne(client, row, now);
          if (outcome === "inserted") inserted++;
          else if (outcome === "unchanged") unchanged++;
          else if (outcome === "no_organization") refused.push({ legacyId: row.legacyId, code: outcome });
          else conflicts.push({ legacyId: row.legacyId, existingDigest: outcome.existing, incomingDigest: row.digest });
          await client.query("RELEASE SAVEPOINT contact_import");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT contact_import");
          await client.query("RELEASE SAVEPOINT contact_import");
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

  async #importOne(client: PoolClient, row: ContactImportRow, now: string): Promise<"inserted" | "unchanged" | "no_organization" | { existing: string }> {
    const { rows: [held] } = await client.query<{ digest: string }>(
      "SELECT digest FROM legacy_id_maps WHERE legacy_table = $1 AND legacy_id = $2 FOR UPDATE", [LEGACY_TABLE, row.legacyId]);
    if (held) return held.digest === row.digest ? "unchanged" : { existing: held.digest };
    const { rows: [org] } = await client.query<{ platform_id: string }>(
      "SELECT platform_id FROM legacy_id_maps WHERE legacy_table = 'company' AND legacy_id = $1 AND entity = 'organization'", [row.companyLegacyId]);
    if (!org) return "no_organization";
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`access:org:${org.platform_id}`, ORG_LOCK_KEY]);
    const id = randomUUID();
    const createdAt = row.createdAt ?? now;
    const updatedAt = row.updatedAt ?? createdAt;
    await client.query(
      `INSERT INTO company_contacts (id, org_id, name, role_title, created_by, created_at, updated_by, updated_at, removed_at, removed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $5, $7, $8, $9)`,
      [id, org.platform_id, row.name, row.roleTitle, this.actorRef, createdAt, updatedAt, row.removed ? updatedAt : null, row.removed ? this.actorRef : null]);
    const channels = [
      ...row.phones.map((value, position) => ["phone", position, value] as const),
      ...row.emails.map((value, position) => ["email", position, value] as const),
    ];
    if (channels.length > 0) {
      await client.query(
        `INSERT INTO company_contact_channels (contact_id, kind, position, value, label)
         SELECT $1, kind, position, value, NULL FROM unnest($2::text[], $3::smallint[], $4::text[]) AS c(kind, position, value)`,
        [id, channels.map((c) => c[0]), channels.map((c) => c[1]), channels.map((c) => c[2])]);
    }
    await client.query(
      "INSERT INTO legacy_id_maps (legacy_table, legacy_id, entity, platform_id, outcome, digest) VALUES ($1, $2, $3, $4, 'imported', $5)",
      [LEGACY_TABLE, row.legacyId, ENTITY, id, row.digest]);
    return "inserted";
  }

  /** Legacy company link ids against the id map; reported skips listed apart from unexplained gaps. */
  async reconcile(legacyIds: readonly string[], reportedIds: readonly string[] = []) {
    const { rows } = await this.#pool.query<{ legacy_id: string }>(
      "SELECT legacy_id FROM legacy_id_maps WHERE legacy_table = $1 AND entity = $2", [LEGACY_TABLE, ENTITY]);
    const mapped = new Set(rows.map((r) => r.legacy_id));
    const source = new Set(legacyIds);
    const reported = new Set(reportedIds);
    const absent = [...source].filter((id) => !mapped.has(id)).sort();
    return Object.freeze({
      legacyTable: LEGACY_TABLE,
      legacy: source.size,
      imported: [...mapped].filter((id) => source.has(id)).length,
      skipped: Object.freeze(absent.filter((id) => reported.has(id))),
      missing: Object.freeze(absent.filter((id) => !reported.has(id))),
      extra: Object.freeze([...mapped].filter((id) => !source.has(id)).sort()),
    });
  }
}
