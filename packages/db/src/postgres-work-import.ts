// Work lane import writes (M-5). The importer lane reads the legacy mirror,
// calls packages/work/src/legacy.ts to map rows and resolve ids, then calls
// these. Contract (same as tools/legacy-import runImport):
// - keyed by legacy_ref; a re-run with the same row writes nothing (unchanged);
// - a legacy_ref already held with different content is a conflict carrying
//   both digests, never overwritten; the one exception is an open-ended
//   placement whose end date legacy has since set (incremental sync), which is
//   applied and counted as updated;
// - a row the work rules refuse (overlap, mismatched placement) is reported
//   with a code and the batch goes on; each row runs in its own savepoint;
// - one transaction per batch.

import { createHash, randomUUID } from "node:crypto";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";
import { PoolOwner, guarded } from "./postgres-work-store.js";

type IsoDate = string;
export interface WorkImportResult {
  readonly inserted: number;
  readonly unchanged: number;
  readonly updated: number;
  readonly conflicts: readonly { readonly legacyRef: string; readonly existingDigest: string; readonly incomingDigest: string }[];
  readonly refused: readonly { readonly legacyRef: string; readonly code: "overlap" | "no_placement" | "no_session" | "invalid" }[];
}
export interface WorkImportPlacement {
  readonly legacyRef: string; readonly personId: string; readonly orgId: string; readonly storeId: string;
  readonly startDate: IsoDate; readonly endDate: IsoDate | null; readonly payContractId: string | null;
}
export interface WorkImportSession {
  readonly legacyRef: string; readonly placementLegacyRef: string; readonly workDate: IsoDate;
  readonly startedAt: string; readonly endedAt: string;
  readonly startLocation: { readonly latitude: number; readonly longitude: number } | null;
  readonly endLocation: { readonly latitude: number; readonly longitude: number } | null;
  readonly status: "pending" | "approved" | "rejected"; readonly flags: readonly "location_missing"[]; readonly note: string | null;
}
export interface WorkImportDecision {
  readonly legacyRef: string; readonly personId: string; readonly orgId: string; readonly storeId: string; readonly workDate: IsoDate;
  readonly scope: "session" | "day";
  /** The session a session-scope decision names; day decisions name the day's imported sessions. */
  readonly sessionLegacyRef: string | null;
  readonly outcome: "approved" | "rejected"; readonly reason: string | null; readonly note: string | null; readonly rating: number | null;
  readonly notePublic: boolean; readonly decidedBy: string | null; readonly legacyDecidedBy: string | null; readonly decidedAt: string | null;
}

/** sha256 of canonical JSON (keys sorted at every level). */
export function workImportDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

const isOverlap = (e: unknown) => (e as { code?: string }).code === "23P01";
const isRuleRefusal = (e: unknown) => (e as { code?: string }).code === "23514" || (e as { code?: string }).code === "23503";

class Tally {
  inserted = 0; unchanged = 0; updated = 0;
  conflicts: { legacyRef: string; existingDigest: string; incomingDigest: string }[] = [];
  refused: { legacyRef: string; code: "overlap" | "no_placement" | "no_session" | "invalid" }[] = [];
  result(): WorkImportResult {
    return Object.freeze({ inserted: this.inserted, unchanged: this.unchanged, updated: this.updated, conflicts: Object.freeze(this.conflicts), refused: Object.freeze(this.refused) });
  }
}

export class PostgresWorkImportStore {
  readonly #db: PoolOwner;
  constructor(poolOrConfig: PgPool | PoolConfig) { this.#db = new PoolOwner(poolOrConfig); }
  async close(): Promise<void> { await this.#db.close(); }

  async importPlacements(rows: readonly WorkImportPlacement[]): Promise<WorkImportResult> {
    return this.#batch(rows, async (client, row, tally) => {
      const digest = workImportDigest({ ...row, endDate: null });
      const { rows: held } = await client.query<{ id: string; legacy_digest: string; end_date: string | null }>(
        "SELECT id, legacy_digest, to_char(end_date,'YYYY-MM-DD') AS end_date FROM work_assignments WHERE legacy_ref = $1 FOR UPDATE", [row.legacyRef]);
      const existing = held[0];
      if (existing) {
        if (existing.legacy_digest !== digest) { tally.conflicts.push({ legacyRef: row.legacyRef, existingDigest: existing.legacy_digest, incomingDigest: digest }); return; }
        if (existing.end_date === row.endDate) { tally.unchanged++; return; }
        await guarded(client, () => client.query("UPDATE work_assignments SET end_date = $2::date WHERE id = $1", [existing.id, row.endDate]));
        tally.updated++;
        return;
      }
      await guarded(client, () => client.query(`INSERT INTO work_assignments(id, person_principal_id, org_id, store_id, pay_contract_id, contract_resolution,
        start_date, end_date, source, legacy_ref, legacy_digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::date,$8::date,'import',$9,$10)`,
      [randomUUID(), row.personId, row.orgId, row.storeId, row.payContractId,
        JSON.stringify({ version: "studenthub.pay-rate-resolution.v1", steps: ["imported_from_legacy"], matchedContractIds: row.payContractId ? [row.payContractId] : [], contractId: row.payContractId }),
        row.startDate, row.endDate, row.legacyRef, digest]));
      tally.inserted++;
    });
  }

  async importSessions(rows: readonly WorkImportSession[]): Promise<WorkImportResult> {
    return this.#batch(rows, async (client, row, tally) => {
      const digest = workImportDigest(row);
      const { rows: held } = await client.query<{ legacy_digest: string }>("SELECT legacy_digest FROM work_sessions WHERE legacy_ref = $1", [row.legacyRef]);
      if (held[0]) { this.#same(tally, row.legacyRef, held[0].legacy_digest, digest); return; }
      const { rows: placement } = await client.query<{ id: string; person_principal_id: string; org_id: string; store_id: string }>(
        "SELECT id, person_principal_id, org_id, store_id FROM work_assignments WHERE legacy_ref = $1", [row.placementLegacyRef]);
      const a = placement[0];
      if (!a) { tally.refused.push({ legacyRef: row.legacyRef, code: "no_placement" }); return; }
      await guarded(client, () => client.query(`INSERT INTO work_sessions(id, assignment_id, person_principal_id, org_id, store_id, work_date, started_at, ended_at,
        start_latitude, start_longitude, end_latitude, end_longitude, source, status, flags, note, legacy_ref, legacy_digest)
        VALUES($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,'import',$13,$14::text[],$15,$16,$17)`,
      [randomUUID(), a.id, a.person_principal_id, a.org_id, a.store_id, row.workDate, row.startedAt, row.endedAt,
        row.startLocation?.latitude ?? null, row.startLocation?.longitude ?? null, row.endLocation?.latitude ?? null, row.endLocation?.longitude ?? null,
        row.status, [...row.flags], row.note, row.legacyRef, digest]));
      tally.inserted++;
    });
  }

  /**
   * Imported decisions, then each decided imported session links to the
   * latest decision naming it with its own legacy status.
   */
  async importDecisions(rows: readonly WorkImportDecision[]): Promise<WorkImportResult> {
    const result = await this.#batch(rows, async (client, row, tally) => {
      const digest = workImportDigest(row);
      const { rows: held } = await client.query<{ legacy_digest: string }>("SELECT legacy_digest FROM work_decisions WHERE legacy_ref = $1", [row.legacyRef]);
      if (held[0]) { this.#same(tally, row.legacyRef, held[0].legacy_digest, digest); return; }
      const { rows: sessions } = row.scope === "session"
        ? await client.query<{ id: string }>("SELECT id FROM work_sessions WHERE legacy_ref = $1", [row.sessionLegacyRef])
        : await client.query<{ id: string }>(`SELECT id FROM work_sessions WHERE source = 'import' AND person_principal_id = $1 AND store_id = $2 AND work_date = $3::date
            AND deleted_at IS NULL ORDER BY started_at, id`, [row.personId, row.storeId, row.workDate]);
      if (row.scope === "session" && sessions.length === 0) { tally.refused.push({ legacyRef: row.legacyRef, code: "no_session" }); return; }
      await guarded(client, () => client.query(`INSERT INTO work_decisions(id, org_id, store_id, person_principal_id, work_date, scope, outcome, session_ids, reason, note, rating,
        note_public, decided_by, decided_at, legacy_ref, legacy_digest, legacy_decided_by)
        VALUES($1,$2,$3,$4,$5::date,$6,$7,$8::uuid[],$9,$10,$11,$12,$13,coalesce($14::timestamptz, clock_timestamp()),$15,$16,$17)`,
      [randomUUID(), row.orgId, row.storeId, row.personId, row.workDate, row.scope, row.outcome, sessions.map((s) => s.id), row.reason, row.note, row.rating,
        row.notePublic, row.decidedBy, row.decidedAt, row.legacyRef, digest, row.legacyDecidedBy]));
      tally.inserted++;
    }, async (client) => {
      await client.query(`WITH pick AS (
          SELECT DISTINCT ON (s.id) s.id AS session_id, d.id AS decision_id FROM work_sessions s
          JOIN work_decisions d ON s.id = ANY(d.session_ids) AND d.outcome = s.status AND d.legacy_ref IS NOT NULL
          WHERE s.source = 'import' AND s.status <> 'pending' ORDER BY s.id, d.decided_at DESC, d.id DESC)
        UPDATE work_sessions s SET decision_id = p.decision_id FROM pick p WHERE s.id = p.session_id AND s.decision_id IS DISTINCT FROM p.decision_id`);
    });
    return result;
  }

  #same(tally: Tally, legacyRef: string, existing: string, incoming: string): void {
    if (existing === incoming) tally.unchanged++; else tally.conflicts.push({ legacyRef, existingDigest: existing, incomingDigest: incoming });
  }

  async #batch<R extends { readonly legacyRef: string }>(rows: readonly R[], each: (client: PoolClient, row: R, tally: Tally) => Promise<void>,
    after?: (client: PoolClient) => Promise<void>): Promise<WorkImportResult> {
    return this.#db.transaction(async (client) => {
      const tally = new Tally();
      for (const row of rows) {
        try {
          await each(client, row, tally);
        } catch (error) {
          if (isOverlap(error)) tally.refused.push({ legacyRef: row.legacyRef, code: "overlap" });
          else if (isRuleRefusal(error)) tally.refused.push({ legacyRef: row.legacyRef, code: "invalid" });
          else throw error;
        }
      }
      if (after) await after(client);
      return tally.result();
    });
  }
}
