// Cutover lane M-2, promotion step: one staged legacy document into a linked person's empty slot.
//
// The caller (`m4 docpromote`) hands over a staged row that a complete doccopy receipt covers and
// the bytes it read back from staging. This step re-verifies those bytes against the row, then, in
// ONE transaction on the person's own store row (migration 0661, the lock every upload, replace and
// remove of that person takes):
//
// - the promotion ledger (`legacy_document_promotions`, migration 0662) has no row for this person
//   and kind: a principal and kind are promoted, or found held, at most once;
// - the verified legacy link (`legacy_account_links`) still names this legacy candidate, read FOR
//   SHARE so an unlink waits;
// - the staged row (`legacy_candidate_documents`) is still exactly the one handed over;
// - the slot has no history (`candidate_document_slots`: never held, active or cleared), no current
//   or retired version in the person's state, and no upload in progress. A slot the person ever
//   filled or cleared is theirs: it is recorded as `personHeld` and never refilled.
//
// Only then is the document added and the ledger row written, and both commit together with the
// store's own id index and slot history. A promoted civil ID photo is also recorded as already seen
// by OCR (`civil_id_ocr_jobs`, status `noted`), in the same transaction, as the first OCR sweep does
// for the photos present when OCR was switched on: the sweep never queues it, so promotion adds no
// OCR cost and no review. A person's own later upload is read as usual. The object goes to the live bucket under a content-
// addressed immutable key, create-only, and is read back and compared before the commit.
//
// The document id and version are derived from (principal, legacy id, kind, generation, sha256), so
// a retry after an uncertain write names the same object key: the create-only write then finds the
// object, reads it back and compares it, and the same commit happens once. An object written by a
// run that then rolled back stays reserved (candidate_document_object_reservations), never deleted.
//
// Results carry fixed outcome codes only: no principal, legacy id, key or byte leaves this module.

import { createHash } from 'node:crypto';

import { validateCandidateContent } from './candidate-content.js';
import { CANDIDATE_DOCUMENT_ADMISSION } from './candidate-lifecycle.js';
import { CANDIDATE_DOCUMENT_TYPES, type CandidateDocumentType } from './lifecycle-state.js';
import { R2DocumentStore, type PartitionSql, type PostgresDocumentPartitions, type PrivateObjectPort } from './r2-storage.js';

export const DOCUMENT_PROMOTION_REVISION = 'document-promotion-v1';

/** A staged legacy document, as the staging table records it. */
export interface StagedLegacyDocument {
  readonly legacyId: string;
  readonly kind: CandidateDocumentType;
  readonly generation: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly objectKey: string;
}

/**
 * promoted: written into the empty slot. personHeld: the slot has history, a version or a retired
 * version (recorded; never refilled). alreadyPromoted: the ledger has this person and kind.
 * Not recorded, a later run tries again: notLinked (no link), linkChanged (linked to another
 * candidate), stagedChanged (the staged row is not the one handed over), uploadInProgress.
 * ineligible: the principal id is outside the document store's owner format, so that person can
 * hold no candidate document at all (nothing recorded; reported on every run, never a stall).
 */
export type DocumentPromotionOutcome = 'promoted' | 'personHeld' | 'alreadyPromoted' | 'notLinked' | 'linkChanged' | 'stagedChanged' | 'uploadInProgress' | 'ineligible';

/** The only error this step throws: any other failure rolls the person back and carries nothing. */
export class DocumentPromotionError extends Error {
  readonly code = 'm2.promote.failed' as const;
  constructor() { super('m2.promote.failed'); this.name = 'DocumentPromotionError'; }
}

const LEGACY_ID = /^[1-9][0-9]{0,17}$/;
/** The per-owner store's owner id format (r2-storage checkOwner): only such a person can hold candidate documents. */
const PRINCIPAL = /^[A-Za-z0-9_-]{1,128}$/;
const ORG = /^[A-Za-z0-9_-]{1,128}$/;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** A version-4-shaped UUID derived from `parts`: the same inputs always name the same id. */
export function derivedUuid(label: string, parts: readonly string[]): string {
  const h = sha(JSON.stringify([label, ...parts]));
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The id and version a promotion of this staged document into this person's slot uses. */
export function promotionIds(principalId: string, staged: StagedLegacyDocument): { id: string; version: string } {
  const parts = [principalId, staged.legacyId, staged.kind, staged.generation, staged.sha256];
  return { id: derivedUuid('legacy-document-id-v1', parts), version: derivedUuid('legacy-document-version-v1', parts) };
}

function checkStaged(s: StagedLegacyDocument): void {
  if (!LEGACY_ID.test(s.legacyId) || !CANDIDATE_DOCUMENT_TYPES.includes(s.kind) || !GENERATION.test(s.generation) || !SHA256.test(s.sha256)
    || !CANDIDATE_DOCUMENT_ADMISSION[s.kind].mimeTypes.includes(s.mime) || !Number.isSafeInteger(s.size) || s.size < 1
    || s.size > CANDIDATE_DOCUMENT_ADMISSION[s.kind].maxBytes
    || s.objectKey !== `legacy-import/${s.generation}/${s.legacyId}/${s.kind}/${s.sha256}`) throw new DocumentPromotionError();
}

/** The live bucket, with every new object read back and compared before the transaction commits. */
export function readBackObjects(objects: PrivateObjectPort): PrivateObjectPort {
  return {
    read: (key, maximum) => objects.read(key, maximum),
    async writeImmutable(key, bytes, mime) {
      await objects.writeImmutable(key, bytes, mime);
      const back = await objects.read(key, bytes.length);
      if (!back.equals(bytes)) throw new Error('unavailable');
    },
  };
}

export interface DocumentPromotionOptions {
  readonly partitions: PostgresDocumentPartitions;
  /** The live document bucket (never the staging or legacy bucket). */
  readonly objects: PrivateObjectPort;
  /** The candidate documents' server-owned organization (DOCUMENT_ORG_ID). */
  readonly orgId: string;
  readonly now?: () => number;
}

export class LegacyDocumentPromotion {
  readonly #options: DocumentPromotionOptions;
  readonly #objects: PrivateObjectPort;
  constructor(options: DocumentPromotionOptions) {
    if (!ORG.test(options.orgId)) throw new TypeError('invalid promotion configuration');
    this.#options = options;
    this.#objects = readBackObjects(options.objects);
  }

  /**
   * Promotes one staged document into `principalId`'s slot of that kind. `bytes` are the staged
   * object as read back from staging; they must match the row exactly. `binding` names the accepted
   * doccopy and this run, recorded on the ledger row.
   */
  async promote(principalId: string, staged: StagedLegacyDocument, bytes: Buffer,
    binding: { readonly acceptedCopy: string; readonly invocation: string }): Promise<DocumentPromotionOutcome> {
    if (typeof principalId !== 'string' || !UUID.test(binding.acceptedCopy) || !UUID.test(binding.invocation)) throw new DocumentPromotionError();
    // A real principal whose id the document store cannot own (for example one with '@' or '.') is
    // reported, not a failure: the walk goes on past it.
    if (!PRINCIPAL.test(principalId)) return 'ineligible';
    checkStaged(staged);
    if (!Buffer.isBuffer(bytes) || bytes.length !== staged.size || sha(bytes) !== staged.sha256) throw new DocumentPromotionError();
    try { validateCandidateContent(staged.kind, staged.mime, bytes); } catch { throw new DocumentPromotionError(); }
    const { orgId } = this.#options;
    const now = (this.#options.now ?? Date.now)();
    const ids = promotionIds(principalId, staged);
    const store = new R2DocumentStore(this.#options.partitions.port({ kind: 'person', id: principalId }), this.#objects);
    try {
      return await store.transactionWithSql(async (state, sql) => {
        if (await ledgered(sql, principalId, staged.kind)) return 'alreadyPromoted';
        const link = await sql.query('SELECT legacy_candidate_id FROM legacy_account_links WHERE principal_id = $1 FOR SHARE', [principalId]);
        if (link.rowCount !== 1) return 'notLinked';
        if (link.rows[0]!.legacy_candidate_id !== staged.legacyId) return 'linkChanged';
        if (!await sameStaged(sql, staged)) return 'stagedChanged';
        const slot = await sql.query('SELECT 1 FROM candidate_document_slots WHERE person_id = $1 AND org_id = $2 AND type = $3', [principalId, orgId, staged.kind]);
        const mine = (d: { scope: { orgId: string; personId?: string }; type: string }) => d.scope.orgId === orgId && d.scope.personId === principalId && d.type === staged.kind;
        if (slot.rowCount !== 0 || state.documents.some(mine) || state.retired.some(mine)) {
          await record(sql, principalId, staged, orgId, 'personHeld', null, binding);
          return 'personHeld';
        }
        if (state.lifecycle?.uploads.some((t) => t.principalId === principalId && t.orgId === orgId && t.type === staged.kind && !t.committed && t.expiresAt > now)) return 'uploadInProgress';
        if (state.documents.some((d) => d.id === ids.id) || state.retired.some((d) => d.id === ids.id)) throw new DocumentPromotionError();
        state.documents.push({ id: ids.id, version: ids.version, type: staged.kind, mime: staged.mime, size: staged.size,
          scope: { orgId, personId: principalId }, acl: 'private', data: bytes.toString('base64') });
        await record(sql, principalId, staged, orgId, 'promoted', ids, binding);
        return 'promoted';
      });
    } catch {
      throw new DocumentPromotionError();
    }
  }
}

async function ledgered(sql: PartitionSql, principalId: string, kind: string): Promise<boolean> {
  return (await sql.query('SELECT 1 FROM legacy_document_promotions WHERE principal_id = $1 AND kind = $2', [principalId, kind])).rowCount === 1;
}

async function sameStaged(sql: PartitionSql, s: StagedLegacyDocument): Promise<boolean> {
  const { rows } = await sql.query(`SELECT mime, size, sha256, object_key FROM legacy_candidate_documents
    WHERE legacy_candidate_id = $1 AND kind = $2 AND generation = $3`, [s.legacyId, s.kind, s.generation]);
  const r = rows[0];
  return rows.length === 1 && r!.mime === s.mime && Number(r!.size) === s.size && r!.sha256 === s.sha256 && r!.object_key === s.objectKey;
}

async function record(sql: PartitionSql, principalId: string, s: StagedLegacyDocument, orgId: string, outcome: 'promoted' | 'personHeld',
  ids: { id: string; version: string } | null, binding: { acceptedCopy: string; invocation: string }): Promise<void> {
  await sql.query(`INSERT INTO legacy_document_promotions
      (principal_id, kind, legacy_candidate_id, generation, sha256, org_id, outcome, document_id, document_version, revision, accepted_copy, invocation)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [principalId, s.kind, s.legacyId, s.generation, s.sha256, orgId, outcome, ids?.id ?? null, ids?.version ?? null, DOCUMENT_PROMOTION_REVISION,
      binding.acceptedCopy, binding.invocation]);
  // Legacy civil ID photos are not read by OCR: noted, never pending (see the header).
  if (ids && (s.kind === 'civil-id-front' || s.kind === 'civil-id-back')) {
    await sql.query(`INSERT INTO civil_id_ocr_jobs (id, principal_id, org_id, side, document_id, document_version, status, not_before, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'noted', clock_timestamp(), clock_timestamp(), clock_timestamp())
      ON CONFLICT (document_id, document_version) DO NOTHING`, [principalId, orgId, s.kind === 'civil-id-front' ? 'front' : 'back', ids.id, ids.version]);
  }
}
