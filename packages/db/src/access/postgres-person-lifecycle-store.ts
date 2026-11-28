import { randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * A-02 slice 1 (migration 0595): staff warn and tag a person, as legacy candidate_warning and candidate_tag.
 *
 * Legacy benchmark, BAWES-Universe/studenthub@55119d3: staff/modules/v1/controllers/CandidateController.php
 * (actionWarnCandidate, actionUpdateWarning, actionCandidateWarnings, actionAddTag, actionUpdateTags),
 * common/models/CandidateWarning.php (a new warning emails the person: subject the title, body the message),
 * common/models/CandidateTag.php and staff/models/Candidate.php updateTags.
 *
 * Every read and write re-reads the caller's grants inside its own transaction, locked FOR SHARE as the other
 * access stores do so a concurrent revocation is serialized, and goes ahead only when `staffDecision` passes (operator staff or admin); anyone else, and a person who does not exist, gets null or
 * not_found. Companies and the person themselves never read warnings or tags through this store.
 */

type Grant = { readonly org_id: string; readonly role: string; readonly scope: string };

export interface PersonLifecycleStoreOptions {
  readonly pool: pg.Pool;
  /** Operator staff or admin. */
  readonly staffDecision: (grants: readonly Grant[]) => boolean;
  readonly newId?: () => string;
}

export interface PersonWarningRecord {
  readonly id: string; readonly title: string; readonly message: string;
  readonly created_by_name: string | null; readonly created_at: string;
  readonly version: number; readonly updated_by_name: string | null; readonly updated_at: string | null;
}
export interface PersonTagRecord {
  readonly id: string; readonly tag: string; readonly reason: string | null; readonly created_by_name: string | null; readonly created_at: string;
}
export interface PersonLifecycle { readonly warnings: readonly PersonWarningRecord[]; readonly tags: readonly PersonTagRecord[] }

export interface PersonWarningInput { readonly title: string; readonly message: string }
export interface PersonTagInput { readonly tag: string; readonly reason: string }

export type PersonWarnResult = { kind: "warned"; warningId: string } | { kind: "not_found" };
export type PersonWarningCorrectResult = { kind: "corrected"; version: number } | { kind: "not_found" } | { kind: "stale"; version: number };
export type PersonTagResult = { kind: "tagged"; tagId: string } | { kind: "not_found" } | { kind: "duplicate" };
export type PersonTagRemoveResult = { kind: "removed" } | { kind: "not_found" };

const NAME = (column: string) => `(SELECT COALESCE(pp.display_name, p.display_name) FROM principals p LEFT JOIN person_profiles pp ON pp.principal_id = p.id WHERE p.id = ${column})`;
const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

export class PostgresPersonLifecycleStore {
  readonly #pool: pg.Pool;
  constructor(readonly options: PersonLifecycleStoreOptions) { this.#pool = options.pool; }

  /**
   * One transaction: the caller must be staff and the person must exist, else nothing happens and null comes back.
   * Reads too take the grant and person rows FOR SHARE (so not READ ONLY): a revocation that commits first is seen,
   * and one that starts later waits until this transaction ends.
   */
  async #staffTransaction<T>(actorId: string, principalId: string, work: (c: pg.PoolClient) => Promise<T>): Promise<T | null> {
    const c = await this.#pool.connect();
    let broken = false;
    try {
      await c.query("BEGIN");
      const grants = (await c.query<Grant>("SELECT org_id, role, scope FROM grants WHERE principal_id = $1::text ORDER BY id FOR SHARE", [actorId])).rows;
      const exists = (await c.query("SELECT 1 FROM principals WHERE id = $1::text FOR SHARE", [principalId])).rowCount === 1;
      const result = this.options.staffDecision(grants) && exists ? await work(c) : null;
      await c.query("COMMIT");
      return result;
    } catch (error) {
      try { await c.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally {
      c.release(broken);
    }
  }

  /** The person's warnings, newest first (legacy actionCandidateWarnings), and their live tags, newest first. */
  async read(actorId: string, principalId: string): Promise<PersonLifecycle | null> {
    return this.#staffTransaction(actorId, principalId, async (c) => {
      const warnings = (await c.query<PersonWarningRecord>(
        `SELECT id, title, message, ${NAME("w.created_by")} AS created_by_name, created_at, version, ${NAME("w.updated_by")} AS updated_by_name, updated_at
         FROM person_warnings w WHERE principal_id = $1::text ORDER BY created_at DESC, id`, [principalId])).rows;
      const tags = (await c.query<PersonTagRecord>(
        `SELECT id, tag, reason, ${NAME("t.created_by")} AS created_by_name, created_at
         FROM person_tags t WHERE principal_id = $1::text AND removed_at IS NULL ORDER BY created_at DESC, id`, [principalId])).rows;
      return {
        warnings: warnings.map((w) => ({ ...w, created_at: iso(w.created_at), updated_at: w.updated_at === null ? null : iso(w.updated_at) })),
        tags: tags.map((t) => ({ ...t, created_at: iso(t.created_at) })),
      };
    });
  }

  /** A new warning, and in the same transaction the person's warning email (legacy CandidateWarning::afterSave). */
  async warn(actorId: string, principalId: string, input: PersonWarningInput): Promise<PersonWarnResult> {
    const id = (this.options.newId ?? randomUUID)();
    const done = await this.#staffTransaction(actorId, principalId, async (c) => {
      await c.query("INSERT INTO person_warnings (id, principal_id, title, message, created_by) VALUES ($1::uuid, $2, $3, $4, $5)", [id, principalId, input.title, input.message, actorId]);
      await c.query(`INSERT INTO email_outbox (class, recipient_principal_id, template_parameters, idempotency_key)
        VALUES ('account.notice', $1, $2::jsonb, $3) ON CONFLICT (idempotency_key) DO NOTHING`,
        [principalId, JSON.stringify({ heading: input.title, message: input.message }), `person.warning:${id}`]);
      return true;
    });
    return done ? { kind: "warned", warningId: id } : { kind: "not_found" };
  }

  /** A correction of the person's own warning; the replaced wording is kept. No email, as in legacy. */
  async correctWarning(actorId: string, principalId: string, warningId: string, input: PersonWarningInput & { readonly expectedVersion: number }): Promise<PersonWarningCorrectResult> {
    const result = await this.#staffTransaction(actorId, principalId, async (c): Promise<PersonWarningCorrectResult> => {
      const row = (await c.query<{ version: number }>("SELECT version FROM person_warnings WHERE id = $1::uuid AND principal_id = $2 FOR UPDATE", [warningId, principalId])).rows[0];
      if (!row) return { kind: "not_found" };
      if (row.version !== input.expectedVersion) return { kind: "stale", version: row.version };
      await c.query("UPDATE person_warnings SET title = $2, message = $3, version = version + 1, updated_by = $4, updated_at = clock_timestamp() WHERE id = $1::uuid",
        [warningId, input.title, input.message, actorId]);
      return { kind: "corrected", version: row.version + 1 };
    });
    return result ?? { kind: "not_found" };
  }

  /** A tag with its reason (legacy actionAddTag); one live tag per value, whatever its case. */
  async addTag(actorId: string, principalId: string, input: PersonTagInput): Promise<PersonTagResult> {
    const id = (this.options.newId ?? randomUUID)();
    const result = await this.#staffTransaction(actorId, principalId, async (c): Promise<PersonTagResult> => {
      const inserted = await c.query(`INSERT INTO person_tags (id, principal_id, tag, reason, created_by) VALUES ($1::uuid, $2, $3, $4, $5)
        ON CONFLICT (principal_id, lower(tag)) WHERE removed_at IS NULL DO NOTHING`, [id, principalId, input.tag, input.reason, actorId]);
      return inserted.rowCount === 1 ? { kind: "tagged", tagId: id } : { kind: "duplicate" };
    });
    return result ?? { kind: "not_found" };
  }

  /** Removes one live tag of the person; the row is kept with who removed it and when. */
  async removeTag(actorId: string, principalId: string, tagId: string): Promise<PersonTagRemoveResult> {
    const result = await this.#staffTransaction(actorId, principalId, async (c): Promise<PersonTagRemoveResult> => {
      const removed = await c.query("UPDATE person_tags SET removed_by = $3, removed_at = clock_timestamp() WHERE id = $1::uuid AND principal_id = $2 AND removed_at IS NULL", [tagId, principalId, actorId]);
      return removed.rowCount === 1 ? { kind: "removed" } : { kind: "not_found" };
    });
    return result ?? { kind: "not_found" };
  }
}
