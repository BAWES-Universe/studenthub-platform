// Cutover lane M-1, contact slice: imported legacy candidates' phone, profile handle and civil ID
// are staged in legacy_candidate_contacts (migration 0654), apart from the person-owned tables.
// The same contract as the other imports: a same-digest re-run is unchanged, a changed row is a
// conflict and is never overwritten, each row runs in its own savepoint, one batch is one
// transaction, and batches are serialized with a transaction advisory lock.
//
// The civil ID number is sealed by the caller's sealer (the platform's CivilIdVault), bound to
// the legacy candidate, and stored with its keyed hash. The digest is an HMAC under a separate
// 32-byte key, so a digest cannot be used to guess a phone or a number. Results carry legacy ids
// and refusal codes only: no value, no digest.

import { createHmac } from "node:crypto";
import pg from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";
import { CANONICAL_CANDIDATE_ID } from "./person-snapshot-contract.js";

export interface PersonContactImportRow {
  readonly legacyId: string;
  readonly phone: string | null;
  readonly handle: string | null;
  readonly civilId: { readonly country: "KW" | "BH"; readonly number: string } | null;
  readonly civilIdNeedsReview: boolean | null;
  /** Normalised address legacy marked verified; stored only as its HMAC (verified_email_hmac). */
  readonly verifiedEmail: string | null;
}

/** What the store needs from CivilIdVault (packages/profile); structural, so db does not depend on profile. */
export interface CivilIdSealer {
  readonly keyVersion: number;
  seal(ref: string, country: "KW" | "BH", number: string): { readonly ciphertext: Buffer; readonly hash: Buffer; readonly keyVersion: number };
  /** Opens a sealed number; throws when the key or the binding is wrong. */
  open(ref: string, country: "KW" | "BH", ciphertext: Buffer): string;
}

/**
 * The target's civil ID key verifier (legacy_import_target.civil_key_check, migration 0656): a
 * fixed, non-personal number sealed under the platform's key, bound to its own reference.
 */
export const CIVIL_KEY_CHECK = { ref: "legacy-import:civil-key-check", country: "KW", number: "000000000000" } as const;

/** Whether this sealer's key opens the target's check value. Never throws. */
export function civilKeyOpens(sealer: CivilIdSealer, check: Buffer): boolean {
  try { return sealer.open(CIVIL_KEY_CHECK.ref, CIVIL_KEY_CHECK.country, check) === CIVIL_KEY_CHECK.number; } catch { return false; }
}

/**
 * invalid: off the contract. duplicate: another staged candidate already holds the phone, handle
 * or civil ID. undecryptable: the row is staged with the same digest, but its sealed civil ID does
 * not open to the row's number with this key; it is never overwritten.
 */
export type PersonContactImportRefusal = "invalid" | "duplicate" | "undecryptable";

export interface PersonContactImportResult {
  readonly inserted: number;
  readonly unchanged: number;
  readonly conflicts: readonly { readonly legacyId: string }[];
  readonly refused: readonly { readonly legacyId: string; readonly code: PersonContactImportRefusal }[];
}

const KEYS = ["civilId", "civilIdNeedsReview", "handle", "legacyId", "phone", "verifiedEmail"];
/** A plain printable ASCII address with no upper case: what normaliseVerifiedEmail produces. */
const EMAIL = /^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+$/;
const isNormalisedEmail = (v: unknown) => typeof v === "string" && v.length <= 254 && EMAIL.test(v) && !/[A-Z]/.test(v);

/**
 * The one address normalisation the verified-address fact uses, the same rule as the mapper's
 * normaliseEmail: outer spaces trimmed, the trimmed input must be plain printable ASCII before any
 * case change (so no non-ASCII spelling folds into an ASCII address), then only A-Z lowered, which
 * is locale-invariant. null when the address is outside that form. The cutover compare runs this
 * in JavaScript on principals.email, never a collation-dependent SQL lower().
 */
export function normaliseVerifiedEmail(raw: string): string | null {
  const trimmed = raw.replace(/^ +| +$/g, "");
  if (trimmed.length > 254 || !EMAIL.test(trimmed)) return null;
  return trimmed.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}
const PHONE = /^\+[0-9]{8,15}$/;
const HANDLE = /^[a-z][a-z0-9._-]{2,29}$/;
const CIVIL = { KW: /^[0-9]{12}$/, BH: /^[0-9]{9}$/ } as const;

/** The sealing reference: a staged civil ID is bound to its legacy candidate, never to a principal. */
export const legacyCivilIdRef = (legacyId: string) => `legacy-candidate:${legacyId}`;

/** The closed shape the mapper produces, re-checked before any lookup. */
export function isValidPersonContactRow(row: unknown): row is PersonContactImportRow {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
  const r = row as Record<string, unknown>;
  if (Object.keys(r).sort().join() !== KEYS.join()) return false;
  if (typeof r.legacyId !== "string" || !CANONICAL_CANDIDATE_ID.test(r.legacyId)) return false;
  if (r.phone !== null && !(typeof r.phone === "string" && PHONE.test(r.phone))) return false;
  if (r.handle !== null && !(typeof r.handle === "string" && HANDLE.test(r.handle))) return false;
  if (r.civilId === null) {
    if (r.civilIdNeedsReview !== null) return false;
  } else {
    const c = r.civilId as Record<string, unknown>;
    if (typeof c !== "object" || Array.isArray(c) || Object.keys(c).sort().join() !== "country,number") return false;
    if ((c.country !== "KW" && c.country !== "BH") || typeof c.number !== "string" || !CIVIL[c.country].test(c.number)) return false;
    if (r.civilIdNeedsReview !== null && typeof r.civilIdNeedsReview !== "boolean") return false;
  }
  if (r.verifiedEmail !== null && !isNormalisedEmail(r.verifiedEmail)) return false;
  return r.phone !== null || r.handle !== null || r.civilId !== null || r.verifiedEmail !== null;
}

/**
 * The only error importContacts throws. A database or sealer error can carry a row's values in
 * its message, detail or cause, so it is never passed on: the batch rolls back and this fixed
 * error, with no message detail and no cause, is all a caller (or its log) ever sees.
 */
export class PersonContactImportError extends Error {
  readonly code = "m1.contact.importFailed" as const;
  constructor() {
    super("m1.contact.importFailed");
    this.name = "PersonContactImportError";
  }
}

const refusalOf = (e: unknown): PersonContactImportRefusal | null => {
  const code = (e as { code?: string }).code ?? "";
  if (code === "23505") return "duplicate";
  return ["23514", "22P02"].includes(code) ? "invalid" : null;
};

/**
 * The row digest the store keeps, as a plain function so a plan can bind it without a database:
 * an HMAC under the 32-byte digest key over the row's id and values. Without the key it cannot be
 * used to guess a phone, handle, civil ID or address.
 */
export function personContactDigest(digestKey: Buffer, row: PersonContactImportRow): string {
  if (!Buffer.isBuffer(digestKey) || digestKey.length !== 32) throw new TypeError("digestKey must be 32 bytes");
  const civil = row.civilId ? [row.civilId.country, row.civilId.number] : null;
  return createHmac("sha256", digestKey)
    .update(JSON.stringify(["m1-contact-v2", row.legacyId, row.phone, row.handle, civil, row.civilIdNeedsReview, row.verifiedEmail]))
    .digest("hex");
}

export class PostgresPersonContactImportStore {
  readonly #pool: PgPool;
  readonly #owns: boolean;
  readonly #sealer: CivilIdSealer;
  readonly #digestKey: Buffer;

  /** @param digestKey 32 bytes, kept apart from the civil ID key; the HMAC key for row digests. */
  constructor(poolOrConfig: PgPool | PoolConfig, sealer: CivilIdSealer, digestKey: Buffer) {
    if (!Buffer.isBuffer(digestKey) || digestKey.length !== 32) throw new TypeError("digestKey must be 32 bytes");
    this.#pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#owns = !(poolOrConfig instanceof pg.Pool);
    this.#sealer = sealer;
    this.#digestKey = Buffer.from(digestKey);
  }

  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /**
   * The HMAC a verified address is staged as. Takes an address already in normaliseVerifiedEmail
   * form and refuses anything else; no address is stored.
   */
  emailDigest(normalisedEmail: string): Buffer {
    if (!isNormalisedEmail(normalisedEmail)) throw new TypeError("not a normalised address");
    return createHmac("sha256", this.#digestKey).update(JSON.stringify(["m1-verified-email-v1", normalisedEmail])).digest();
  }

  /**
   * For the cutover compare: normalises a linked person's current principals.email with
   * normaliseVerifiedEmail and returns its HMAC, or null when the address is outside that form
   * (then no verified fact is added).
   */
  currentEmailDigest(rawEmail: string): Buffer | null {
    const normalised = normaliseVerifiedEmail(rawEmail);
    return normalised === null ? null : this.emailDigest(normalised);
  }

  /** HMAC over the row's id and values; never a value-revealing hash. */
  digest(row: PersonContactImportRow): string {
    return personContactDigest(this.#digestKey, row);
  }

  async importContacts(rows: readonly PersonContactImportRow[]): Promise<PersonContactImportResult> {
    let inserted = 0, unchanged = 0;
    const conflicts: { legacyId: string }[] = [];
    const refused: { legacyId: string; code: PersonContactImportRefusal }[] = [];
    let client: PoolClient;
    try { client = await this.#pool.connect(); } catch { throw new PersonContactImportError(); }
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('legacy-import:person_contact', 0))");
      for (const row of rows) {
        // Checked before any lookup: an invalid row is refused whether or not its id is staged.
        if (!isValidPersonContactRow(row)) {
          const id = (row as { legacyId?: unknown } | null)?.legacyId;
          refused.push({ legacyId: typeof id === "string" && CANONICAL_CANDIDATE_ID.test(id) ? id : "?", code: "invalid" });
          continue;
        }
        await client.query("SAVEPOINT contact_import");
        try {
          const outcome = await this.#importOne(client, row);
          if (outcome === "inserted") inserted++;
          else if (outcome === "unchanged") unchanged++;
          else if (outcome === "undecryptable") refused.push({ legacyId: row.legacyId, code: "undecryptable" });
          else conflicts.push({ legacyId: row.legacyId });
          await client.query("RELEASE SAVEPOINT contact_import");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT contact_import");
          await client.query("RELEASE SAVEPOINT contact_import");
          const code = refusalOf(error);
          if (code === null) throw error;
          refused.push({ legacyId: row.legacyId, code });
        }
      }
      await client.query("COMMIT");
      return Object.freeze({ inserted, unchanged, conflicts: Object.freeze(conflicts), refused: Object.freeze(refused) });
    } catch {
      try { await client.query("ROLLBACK"); } catch { broken = true; }
      throw new PersonContactImportError();
    } finally {
      client.release(broken);
    }
  }

  #opens(row: PersonContactImportRow, country: "KW" | "BH" | null, ciphertext: Buffer | null): boolean {
    if (!row.civilId || country !== row.civilId.country || !ciphertext) return false;
    try { return this.#sealer.open(legacyCivilIdRef(row.legacyId), country, ciphertext) === row.civilId.number; } catch { return false; }
  }

  async #importOne(client: PoolClient, row: PersonContactImportRow): Promise<"inserted" | "unchanged" | "conflict" | "undecryptable"> {
    const digest = this.digest(row);
    const { rows: held } = await client.query<{ digest: string; civil_country: "KW" | "BH" | null; civil_number_ciphertext: Buffer | null }>(
      "SELECT digest, civil_country, civil_number_ciphertext FROM legacy_candidate_contacts WHERE legacy_candidate_id = $1 FOR UPDATE", [row.legacyId]);
    if (held[0]) {
      if (held[0].digest !== digest) return "conflict";
      // A matching digest proves the values, not the ciphertext: the staged civil ID must still
      // open to the row's number under this key, or the replay is refused (never overwritten).
      if (row.civilId && !this.#opens(row, held[0].civil_country, held[0].civil_number_ciphertext)) return "undecryptable";
      return "unchanged";
    }
    const sealed = row.civilId ? this.#sealer.seal(legacyCivilIdRef(row.legacyId), row.civilId.country, row.civilId.number) : null;
    await client.query(
      `INSERT INTO legacy_candidate_contacts (legacy_candidate_id, phone, profile_handle, civil_country, civil_number_ciphertext,
         civil_number_hash, civil_key_version, civil_needs_review, verified_email_hmac, digest) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [row.legacyId, row.phone, row.handle, row.civilId?.country ?? null, sealed?.ciphertext ?? null, sealed?.hash ?? null,
        sealed?.keyVersion ?? null, row.civilId ? row.civilIdNeedsReview : null,
        row.verifiedEmail === null ? null : this.emailDigest(row.verifiedEmail), digest]);
    return "inserted";
  }

  /**
   * Id coverage only: legacy candidate ids with values against the staged rows, reported skips
   * listed apart from unexplained gaps. It is not proof of an import on its own: the run must also
   * require no conflicts and no unexplained refusals from importContacts.
   */
  async reconcile(legacyIds: readonly string[], reportedIds: readonly string[] = []) {
    const { rows } = await this.#pool.query<{ legacy_candidate_id: string }>("SELECT legacy_candidate_id FROM legacy_candidate_contacts");
    const staged = new Set(rows.map((r) => r.legacy_candidate_id));
    const source = new Set(legacyIds);
    const reported = new Set(reportedIds);
    const absent = [...source].filter((id) => !staged.has(id)).sort();
    return Object.freeze({
      legacyTable: "candidate",
      legacy: source.size,
      imported: [...staged].filter((id) => source.has(id)).length,
      skipped: Object.freeze(absent.filter((id) => reported.has(id))),
      missing: Object.freeze(absent.filter((id) => !reported.has(id))),
      extra: Object.freeze([...staged].filter((id) => !source.has(id)).sort()),
    });
  }
}
