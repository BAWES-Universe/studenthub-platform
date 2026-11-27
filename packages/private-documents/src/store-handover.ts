// Quiesced handover checks around migration 0661 (single-row store to per-owner store).
//
// The migration itself is safe against a writer in flight (it takes ACCESS EXCLUSIVE on the old
// table before reading it, and fences older builds by renaming it). These checks prove the switch
// happened while quiet, and that nothing changed between the check and the migration:
//
// - `precheck` (before 0661, with the gateway and worker stopped): the old table exists, no other
//   transaction holds or awaits a lock on any relation in the store's schema (an idle transaction
//   that touched any table there still holds one), and no prepared transaction exists. It returns
//   the old row's element counts and a digest of it: counts and a hash only, no value.
// - `postcheck` (after 0661, before the new build takes traffic): 0661 is recorded, the per-owner
//   store is authoritative and has accepted no write yet (rollback still allowed), the frozen copy of the old row has exactly the digest the precheck saw
//   (no write slipped in between), and the owner rows hold exactly the counted elements.
//
// Both read in one REPEATABLE READ, READ ONLY transaction and change nothing.

import type pg from 'pg';

export interface StoreCounts {
  readonly documents: number; readonly retired: number; readonly uploads: number;
  readonly receipts: number; readonly cleanup: number; readonly audit: number;
}
export interface HandoverPrecheck { readonly digest: string; readonly counts: StoreCounts }
export interface HandoverPostcheck { readonly counts: StoreCounts; readonly owners: number; readonly rollbackAllowed: true }

export type HandoverCode = 'notBefore0661' | 'locked' | 'prepared' | 'notMigrated' | 'notAuthoritative' | 'alreadyWritten' | 'changedSinceCheck' | 'countMismatch';
export class HandoverError extends Error {
  constructor(readonly code: HandoverCode) { super(`handover.${code}`); this.name = 'HandoverError'; }
}

type Queryable = Pick<pg.ClientBase, 'query'>;
const HEX = /^[0-9a-f]{32}$/;
const count = (path: string, from: string) =>
  `COALESCE(sum(jsonb_array_length(COALESCE(${from}->${path}, '[]'::jsonb))), 0)::int`;
const COUNTS = (from: string) => `${count("'state'->'documents'", from)} AS documents, ${count("'state'->'retired'", from)} AS retired,
  ${count("'state'->'lifecycle'->'uploads'", from)} AS uploads, ${count("'state'->'lifecycle'->'receipts'", from)} AS receipts,
  ${count("'state'->'lifecycle'->'cleanup'", from)} AS cleanup, ${count("'state'->'lifecycle'->'audit'", from)} AS audit`;
const counts = (r: Record<string, unknown>): StoreCounts => ({ documents: Number(r.documents), retired: Number(r.retired), uploads: Number(r.uploads),
  receipts: Number(r.receipts), cleanup: Number(r.cleanup), audit: Number(r.audit) });

async function readOnly<T>(c: Queryable, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try { const r = await fn(); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
}

/** Before 0661: proves the store is quiet and records what the migration must carry. */
export function precheck(c: Queryable): Promise<HandoverPrecheck> {
  return readOnly(c, async () => {
    const t = (await c.query(`SELECT c.oid, c.relnamespace FROM pg_class c WHERE c.oid = to_regclass('candidate_document_snapshot')`)).rows[0];
    if (!t) throw new HandoverError('notBefore0661');
    const held = await c.query(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class r ON r.oid = l.relation
      WHERE l.locktype = 'relation' AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND r.relnamespace = $1 AND l.pid <> pg_backend_pid()`, [t.relnamespace]);
    if (held.rows[0].n !== 0) throw new HandoverError('locked');
    if ((await c.query('SELECT count(*)::int AS n FROM pg_prepared_xacts WHERE database = current_database()')).rows[0].n !== 0) throw new HandoverError('prepared');
    const row = (await c.query(`SELECT md5(s.snapshot::text) AS digest, ${COUNTS('s.snapshot')} FROM candidate_document_snapshot s WHERE s.singleton GROUP BY s.snapshot`)).rows[0];
    if (!row) throw new HandoverError('notBefore0661');
    return { digest: row.digest as string, counts: counts(row) };
  });
}

/** After 0661: the frozen old row is the one the precheck saw, and every counted element has an owner. */
export function postcheck(c: Queryable, expected: HandoverPrecheck): Promise<HandoverPostcheck> {
  if (!expected || !HEX.test(expected.digest)) throw new TypeError('expected precheck required');
  return readOnly(c, async () => {
    const migrated = await c.query(`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0661_candidate_document_partitions') AS ok,
      to_regclass('candidate_document_snapshot_0661_rollback') IS NOT NULL AND to_regclass('candidate_document_snapshot') IS NULL AS renamed`);
    if (!migrated.rows[0].ok || !migrated.rows[0].renamed) throw new HandoverError('notMigrated');
    const authority = (await c.query(`SELECT store, first_write_at IS NULL AS fresh FROM candidate_document_store_authority WHERE singleton`)).rows[0];
    if (authority?.store !== 'partitioned') throw new HandoverError('notAuthoritative');
    // It runs before the new build takes traffic: once a write is accepted the old row is no longer the measure.
    if (authority.fresh !== true) throw new HandoverError('alreadyWritten');
    const frozen = (await c.query('SELECT md5(snapshot::text) AS digest FROM candidate_document_snapshot_0661_rollback WHERE singleton')).rows[0];
    if (frozen?.digest !== expected.digest) throw new HandoverError('changedSinceCheck');
    const now = (await c.query(`SELECT count(*)::int AS owners, ${COUNTS('p.snapshot')} FROM candidate_document_partitions p`)).rows[0];
    const got = counts(now);
    // Before the first write the owner rows hold exactly the old row's elements.
    const keys = Object.keys(expected.counts) as (keyof StoreCounts)[];
    if (keys.some((k) => got[k] !== expected.counts[k])) throw new HandoverError('countMismatch');
    return { counts: got, owners: Number(now.owners), rollbackAllowed: true };
  });
}
