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
// - `target`: a fingerprint of the database and the store table (cluster id where the role may read it,
//   database oid and name, schema, and the old table's oid, which the 0661 rename keeps). The precheck
//   carries it and the postcheck recomputes it, so two identical stores elsewhere never pass as the same
//   one; the operator entry also requires it to equal the approved target. A hash only, no value.
//
// The precheck is point-in-time evidence: it proves the store was quiet when it ran, not that it stayed
// quiet. The digest comparison in the postcheck is what catches a write after it.
//
// Both read in one REPEATABLE READ, READ ONLY transaction and change nothing.

import type pg from 'pg';

export interface StoreCounts {
  readonly documents: number; readonly retired: number; readonly uploads: number;
  readonly receipts: number; readonly cleanup: number; readonly audit: number;
}
export interface HandoverPrecheck { readonly target: string; readonly digest: string; readonly counts: StoreCounts }
export interface HandoverPostcheck { readonly target: string; readonly counts: StoreCounts; readonly owners: number; readonly rollbackAllowed: true }

export type HandoverCode = 'notBefore0661' | 'locked' | 'prepared' | 'notMigrated' | 'notAuthoritative' | 'alreadyWritten'
  | 'changedSinceCheck' | 'countMismatch' | 'precheckInvalid' | 'otherTarget';
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
const COUNT_KEYS = ['documents', 'retired', 'uploads', 'receipts', 'cleanup', 'audit'] as const;
const PRECHECK_KEYS = ['counts', 'digest', 'target'] as const;
const sameKeys = (o: object, keys: readonly string[]) => { const k = Object.keys(o).sort(); return k.length === keys.length && k.every((x, i) => x === [...keys].sort()[i]); };
const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** A precheck record exactly as `precheck` prints it: three fields, two 32-hex hashes and all six counts as
 * nonnegative safe integers, nothing missing and nothing extra. Anything else is refused, never coerced. */
export function parsePrecheck(v: unknown): HandoverPrecheck {
  if (!plain(v) || !sameKeys(v, PRECHECK_KEYS)) throw new HandoverError('precheckInvalid');
  const { target, digest, counts: c } = v;
  if (typeof target !== 'string' || !HEX.test(target) || typeof digest !== 'string' || !HEX.test(digest)) throw new HandoverError('precheckInvalid');
  if (!plain(c) || !sameKeys(c, COUNT_KEYS)) throw new HandoverError('precheckInvalid');
  for (const k of COUNT_KEYS) { const n = c[k]; if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new HandoverError('precheckInvalid'); }
  return { target, digest, counts: Object.fromEntries(COUNT_KEYS.map((k) => [k, c[k] as number])) as unknown as StoreCounts };
}

/** The database and store-table fingerprint for `table` (the old store's name before 0661, its rollback name after). */
async function targetOf(c: Queryable, table: string): Promise<string | null> {
  const r = (await c.query(`SELECT md5(concat_ws('|', 'handover-target-v1',
      CASE WHEN has_function_privilege('pg_control_system()', 'EXECUTE') THEN (SELECT system_identifier::text FROM pg_control_system()) ELSE '' END,
      d.oid::text, d.datname, n.nspname, t.oid::text)) AS target
    FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace, pg_database d
    WHERE t.oid = to_regclass($1) AND d.datname = current_database()`, [table])).rows[0];
  return (r?.target as string | undefined) ?? null;
}

/** Prints only the target fingerprint, for the operator to approve before the precheck. */
export function target(c: Queryable): Promise<string> {
  return readOnly(c, async () => {
    const t = (await targetOf(c, 'candidate_document_snapshot')) ?? (await targetOf(c, 'candidate_document_snapshot_0661_rollback'));
    if (!t) throw new HandoverError('notBefore0661');
    return t;
  });
}

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
    const fingerprint = await targetOf(c, 'candidate_document_snapshot');
    if (!fingerprint) throw new HandoverError('notBefore0661');
    return { target: fingerprint, digest: row.digest as string, counts: counts(row) };
  });
}

/** After 0661: the frozen old row is the one the precheck saw, and every counted element has an owner. */
export async function postcheck(c: Queryable, input: unknown): Promise<HandoverPostcheck> {
  const expected = parsePrecheck(input);
  return readOnly(c, async () => {
    const migrated = await c.query(`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0661_candidate_document_partitions') AS ok,
      to_regclass('candidate_document_snapshot_0661_rollback') IS NOT NULL AND to_regclass('candidate_document_snapshot') IS NULL AS renamed`);
    if (!migrated.rows[0].ok || !migrated.rows[0].renamed) throw new HandoverError('notMigrated');
    // The same database and the same table the precheck read (the rename keeps its oid), not an identical copy elsewhere.
    const fingerprint = await targetOf(c, 'candidate_document_snapshot_0661_rollback');
    if (fingerprint !== expected.target) throw new HandoverError('otherTarget');
    const authority = (await c.query(`SELECT store, first_write_at IS NULL AS fresh FROM candidate_document_store_authority WHERE singleton`)).rows[0];
    if (authority?.store !== 'partitioned') throw new HandoverError('notAuthoritative');
    // It runs before the new build takes traffic: once a write is accepted the old row is no longer the measure.
    if (authority.fresh !== true) throw new HandoverError('alreadyWritten');
    const frozen = (await c.query('SELECT md5(snapshot::text) AS digest FROM candidate_document_snapshot_0661_rollback WHERE singleton')).rows[0];
    if (frozen?.digest !== expected.digest) throw new HandoverError('changedSinceCheck');
    const now = (await c.query(`SELECT count(*)::int AS owners, ${COUNTS('p.snapshot')} FROM candidate_document_partitions p`)).rows[0];
    const got = counts(now);
    // Before the first write the owner rows hold exactly the old row's elements: every one of the six counts.
    if (COUNT_KEYS.some((k) => got[k] !== expected.counts[k])) throw new HandoverError('countMismatch');
    return { target: fingerprint, counts: got, owners: Number(now.owners), rollbackAllowed: true };
  });
}
