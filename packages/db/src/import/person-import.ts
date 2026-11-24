// Cutover lane M-1: imported legacy candidates become approved profile snapshots
// (legacy_candidate_snapshots, migration 0653). Same contract as the M-4 imports: keyed by legacy
// id in legacy_id_maps, a same-digest re-run is unchanged, a changed row is a conflict carrying
// both digests and is never overwritten, each row runs in its own savepoint, one batch is one
// transaction, and batches are serialized with a transaction advisory lock.
// Results carry legacy ids, refusal codes and digests only.

import pg from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";

export interface PersonSnapshotImportRow {
  readonly legacyId: string;
  readonly snapshot: Readonly<Record<string, string | number | null>>;
  readonly digest: string;
}

export type PersonSnapshotImportRefusal = "invalid";

export interface PersonSnapshotImportResult {
  readonly inserted: number;
  readonly unchanged: number;
  readonly conflicts: readonly { readonly legacyId: string; readonly existingDigest: string; readonly incomingDigest: string }[];
  readonly refused: readonly { readonly legacyId: string; readonly code: PersonSnapshotImportRefusal }[];
}

const LEGACY_TABLE = "candidate";
const ENTITY = "person_snapshot";
const isRuleRefusal = (e: unknown) => ["23514", "23503", "23505", "22P02"].includes((e as { code?: string }).code ?? "");

export class PostgresPersonSnapshotImportStore {
  readonly #pool: PgPool;
  readonly #owns: boolean;
  /** @param sourceRevision the legacy revision the profile projector was proven against (PROFILE_PARITY_REVISION). */
  constructor(poolOrConfig: PgPool | PoolConfig, private readonly sourceRevision: string) {
    if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error("sourceRevision must be a 40-hex revision");
    this.#pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#owns = !(poolOrConfig instanceof pg.Pool);
  }

  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  async importPeople(rows: readonly PersonSnapshotImportRow[]): Promise<PersonSnapshotImportResult> {
    let inserted = 0, unchanged = 0;
    const conflicts: { legacyId: string; existingDigest: string; incomingDigest: string }[] = [];
    const refused: { legacyId: string; code: PersonSnapshotImportRefusal }[] = [];
    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('legacy-import:person_snapshot', 0))");
      for (const row of rows) {
        await client.query("SAVEPOINT person_import");
        try {
          const outcome = await this.#importOne(client, row);
          if (outcome === "inserted") inserted++;
          else if (outcome === "unchanged") unchanged++;
          else conflicts.push({ legacyId: row.legacyId, existingDigest: outcome.existing, incomingDigest: row.digest });
          await client.query("RELEASE SAVEPOINT person_import");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT person_import");
          await client.query("RELEASE SAVEPOINT person_import");
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

  async #importOne(client: PoolClient, row: PersonSnapshotImportRow): Promise<"inserted" | "unchanged" | { existing: string }> {
    const { rows: held } = await client.query<{ digest: string }>(
      "SELECT digest FROM legacy_id_maps WHERE legacy_table = $1 AND legacy_id = $2 FOR UPDATE", [LEGACY_TABLE, row.legacyId]);
    if (held[0]) return held[0].digest === row.digest ? "unchanged" : { existing: held[0].digest };
    // The snapshot's own candidate id must be the row's: a mismatch would serve one person another's profile.
    if (row.snapshot.candidate_id !== row.legacyId) throw Object.assign(new Error("candidate id mismatch"), { code: "23514" });
    await client.query("INSERT INTO legacy_candidate_snapshots (legacy_candidate_id, snapshot, source_revision) VALUES ($1, $2::jsonb, $3)",
      [row.legacyId, JSON.stringify(row.snapshot), this.sourceRevision]);
    await client.query(
      "INSERT INTO legacy_id_maps (legacy_table, legacy_id, entity, platform_id, outcome, digest) VALUES ($1, $2, $3, $2, 'imported', $4)",
      [LEGACY_TABLE, row.legacyId, ENTITY, row.digest]);
    return "inserted";
  }

  /** Legacy candidate ids against the id map; reported skips listed apart from unexplained gaps. */
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

/**
 * The approved profile source the legacy link store reads (LegacySnapshotPort.readCandidate):
 * the imported snapshot with its import time and source revision, or undefined when the
 * candidate has no imported snapshot (the link store then reads the person as not imported).
 */
export class PostgresImportedPersonSnapshots {
  readonly #pool: PgPool;
  constructor(pool: PgPool) { this.#pool = pool; }

  async readCandidate(candidateRef: string): Promise<unknown | undefined> {
    if (!/^[1-9][0-9]{0,17}$/.test(candidateRef)) return undefined;
    const { rows } = await this.#pool.query<{ snapshot: Record<string, unknown>; source_revision: string; imported_at: Date }>(
      "SELECT snapshot, source_revision, imported_at FROM legacy_candidate_snapshots WHERE legacy_candidate_id = $1", [candidateRef]);
    const row = rows[0];
    if (!row) return undefined;
    return Object.freeze({ ...row.snapshot, imported_at: row.imported_at.toISOString(), source_revision: row.source_revision });
  }
}
