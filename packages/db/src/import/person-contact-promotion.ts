// Cutover lane M-1, contact slice: the promotion step. For a person linked to a legacy candidate
// (legacy_account_links), it moves that candidate's staged values (legacy_candidate_contacts) into
// the person-owned tables, and only where the person has written nothing:
//
// - phone and profile handle into person_profiles, only while the field's written_at is null (a
//   cleared value is still written, so a person's clear is never undone);
// - the civil ID into person_civil_ids, only when the person has no civil ID row at all (released
//   included), opened from its legacy-candidate binding and re-sealed to the principal;
// - the verified address into principal_email_verifications (verified true, source
//   legacy_import), only when the person's current principals.email, normalised in JavaScript,
//   hashes to the staged HMAC, joined on the current address in SQL, ON CONFLICT DO NOTHING, so an
//   OIDC answer, true or false, always wins. The access lane's trigger serialises the insert with
//   an address change; its refusal is recorded as addressChanged.
//
// A value another person already holds is left for its holder (taken). Each principal is promoted
// once, in one transaction that also writes legacy_contact_promotions (migration 0657), so a value
// the person later clears or changes is never brought back. Results carry the principal's legacy
// id and fixed outcome codes only: no value, digest or address.

import pg from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";
import { PostgresPersonContactImportStore, legacyCivilIdRef, normaliseVerifiedEmail, type CivilIdSealer } from "./person-contact-import.js";

export const CONTACT_PROMOTION_REVISION = "contact-promotion-v1";

/** The per-principal lock the person's own profile, safe-write and authz writes take, so they serialise with this. */
const PRINCIPAL_LOCK_KEY = 5959;

export type ProfileValueOutcome = "promoted" | "none" | "personWritten" | "taken";
export type CivilIdOutcome = ProfileValueOutcome | "undecryptable";
/**
 * answered: the address already has a recorded answer (OIDC true or false, or an earlier import).
 * mismatch: the current address does not hash to the staged one. unverifiable: the current
 * address is outside the normalised form, or has none. addressChanged: the address changed while
 * promoting (the access lane's trigger refused), or the SQL normalisation disagreed.
 */
export type EmailOutcome = "promoted" | "none" | "answered" | "mismatch" | "unverifiable" | "addressChanged";

export interface ContactPromotionOutcomes {
  readonly phone: ProfileValueOutcome;
  readonly handle: ProfileValueOutcome;
  readonly civilId: CivilIdOutcome;
  readonly email: EmailOutcome;
}

export type ContactPromotionResult =
  | { readonly kind: "promoted"; readonly legacyId: string; readonly outcomes: ContactPromotionOutcomes }
  /** notLinked: no link row. notStaged: linked, nothing staged yet (nothing recorded; a later run retries). alreadyPromoted: done before. */
  | { readonly kind: "skipped"; readonly reason: "notLinked" | "notStaged" | "alreadyPromoted" };

/** What the step needs from CivilIdVault: open the staged binding, re-seal to the principal. */
export interface CivilIdResealer extends CivilIdSealer {
  hash(country: "KW" | "BH", number: string): Buffer;
}

/**
 * The only error the step throws. A database or sealer error can carry a value in its message,
 * detail or cause, so it is never passed on: the principal's transaction rolls back and this fixed
 * error is all a caller sees.
 */
export class ContactPromotionError extends Error {
  readonly code = "m1.contact.promotionFailed" as const;
  constructor() {
    super("m1.contact.promotionFailed");
    this.name = "ContactPromotionError";
  }
}

interface StagedRow {
  legacy_candidate_id: string;
  phone: string | null;
  profile_handle: string | null;
  civil_country: "KW" | "BH" | null;
  civil_number_ciphertext: Buffer | null;
  civil_number_hash: Buffer | null;
  civil_needs_review: boolean | null;
  verified_email_hmac: Buffer | null;
}

const PRINCIPAL = /^[^\s].{0,255}$/s;

export class PostgresContactPromotion {
  readonly #pool: PgPool;
  readonly #owns: boolean;
  readonly #sealer: CivilIdResealer;
  readonly #emails: PostgresPersonContactImportStore;

  /**
   * @param sealer the platform's CivilIdVault under the gateway's CIVIL_ID_ENCRYPTION_KEY.
   * @param digestKey the importer's 32-byte digest key, the one the verified address was staged under.
   */
  constructor(poolOrConfig: PgPool | PoolConfig, sealer: CivilIdResealer, digestKey: Buffer) {
    this.#pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#owns = !(poolOrConfig instanceof pg.Pool);
    this.#sealer = sealer;
    this.#emails = new PostgresPersonContactImportStore(this.#pool, sealer, digestKey);
  }

  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /** Linked principals with a staged row and no promotion yet, in id order. */
  async pending(limit = 500): Promise<readonly string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError("limit must be 1 to 10000");
    try {
      const { rows } = await this.#pool.query<{ principal_id: string }>(
        `SELECT l.principal_id FROM legacy_account_links l
           JOIN legacy_candidate_contacts c ON c.legacy_candidate_id = l.legacy_candidate_id
          WHERE NOT EXISTS (SELECT 1 FROM legacy_contact_promotions p WHERE p.principal_id = l.principal_id)
          ORDER BY l.principal_id COLLATE "C" LIMIT $1`, [limit]);
      return rows.map((r) => r.principal_id);
    } catch {
      throw new ContactPromotionError();
    }
  }

  /** Promotes one linked principal, in one transaction. */
  async promote(principalId: string): Promise<ContactPromotionResult> {
    if (typeof principalId !== "string" || !PRINCIPAL.test(principalId)) throw new TypeError("principalId required");
    let client: PoolClient | undefined;
    try {
      client = await this.#pool.connect();
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [principalId, PRINCIPAL_LOCK_KEY]);
      const result = await this.#promote(client, principalId);
      await client.query(result.kind === "promoted" ? "COMMIT" : "ROLLBACK");
      return result;
    } catch {
      await client?.query("ROLLBACK").catch(() => {});
      throw new ContactPromotionError();
    } finally {
      client?.release();
    }
  }

  async #promote(client: PoolClient, principalId: string): Promise<ContactPromotionResult> {
    // FOR SHARE: an unlink waits for this transaction.
    const link = (await client.query<{ legacy_candidate_id: string }>(
      "SELECT legacy_candidate_id FROM legacy_account_links WHERE principal_id = $1 FOR SHARE", [principalId])).rows[0];
    if (!link) return { kind: "skipped", reason: "notLinked" };
    const done = await client.query("SELECT 1 FROM legacy_contact_promotions WHERE principal_id = $1", [principalId]);
    if (done.rowCount) return { kind: "skipped", reason: "alreadyPromoted" };
    const staged = (await client.query<StagedRow>(
      `SELECT legacy_candidate_id, phone, profile_handle, civil_country, civil_number_ciphertext, civil_number_hash,
              civil_needs_review, verified_email_hmac
         FROM legacy_candidate_contacts WHERE legacy_candidate_id = $1`, [link.legacy_candidate_id])).rows[0];
    if (!staged) return { kind: "skipped", reason: "notStaged" };

    const outcomes: ContactPromotionOutcomes = {
      phone: await this.#profileValue(client, principalId, "phone", staged.phone),
      handle: await this.#profileValue(client, principalId, "profile_handle", staged.profile_handle),
      civilId: await this.#civilId(client, principalId, staged),
      email: await this.#email(client, principalId, staged.verified_email_hmac),
    };
    await client.query(
      `INSERT INTO legacy_contact_promotions (principal_id, legacy_candidate_id, revision, phone, handle, civil_id, email)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [principalId, staged.legacy_candidate_id, CONTACT_PROMOTION_REVISION, outcomes.phone, outcomes.handle, outcomes.civilId, outcomes.email]);
    return { kind: "promoted", legacyId: staged.legacy_candidate_id, outcomes };
  }

  /** In a savepoint: a value another person holds trips the unique index and is left (taken). */
  async #savepoint<T>(client: PoolClient, run: () => Promise<T>, onUnique: T): Promise<T> {
    await client.query("SAVEPOINT promote_value");
    try {
      const value = await run();
      await client.query("RELEASE SAVEPOINT promote_value");
      return value;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT promote_value");
      if ((error as { code?: string }).code === "23505") return onUnique;
      throw error;
    }
  }

  async #profileValue(client: PoolClient, principalId: string, column: "phone" | "profile_handle", value: string | null): Promise<ProfileValueOutcome> {
    if (value === null) return "none";
    return this.#savepoint(client, async () => {
      // The column name is one of two fixed literals, never input.
      const written = await client.query(
        `INSERT INTO person_profiles (principal_id, ${column}, ${column}_written_at) VALUES ($1, $2, clock_timestamp())
         ON CONFLICT (principal_id) DO UPDATE SET ${column} = EXCLUDED.${column}, ${column}_written_at = EXCLUDED.${column}_written_at
          WHERE person_profiles.${column}_written_at IS NULL AND person_profiles.${column} IS NULL
         RETURNING 1`, [principalId, value]);
      return written.rowCount === 1 ? "promoted" : "personWritten";
    }, "taken");
  }

  async #civilId(client: PoolClient, principalId: string, staged: StagedRow): Promise<CivilIdOutcome> {
    if (staged.civil_country === null || staged.civil_number_ciphertext === null || staged.civil_number_hash === null) return "none";
    let number: string;
    try {
      number = this.#sealer.open(legacyCivilIdRef(staged.legacy_candidate_id), staged.civil_country, staged.civil_number_ciphertext);
    } catch {
      return "undecryptable";
    }
    if (!this.#sealer.hash(staged.civil_country, number).equals(staged.civil_number_hash)) return "undecryptable";
    const sealed = this.#sealer.seal(principalId, staged.civil_country, number);
    return this.#savepoint(client, async () => {
      // Any existing row, released included, is the person's own: never replaced.
      const written = await client.query(
        `INSERT INTO person_civil_ids (principal_id, country, number_ciphertext, number_hash, key_version, needs_review, revision)
         VALUES ($1, $2, $3, $4, $5, $6, 1) ON CONFLICT (principal_id) DO NOTHING RETURNING 1`,
        [principalId, staged.civil_country, sealed.ciphertext, sealed.hash, sealed.keyVersion, staged.civil_needs_review ?? false]);
      return written.rowCount === 1 ? "promoted" : "personWritten";
    }, "taken");
  }

  async #email(client: PoolClient, principalId: string, stagedHmac: Buffer | null): Promise<EmailOutcome> {
    if (stagedHmac === null) return "none";
    const current = (await client.query<{ email: string | null }>("SELECT email FROM principals WHERE id = $1", [principalId])).rows[0]?.email ?? null;
    // The same JavaScript rule the address was staged under; never a collation-dependent SQL lower().
    const normalised = current === null ? null : normaliseVerifiedEmail(current);
    if (normalised === null) return "unverifiable";
    if (!this.#emails.emailDigest(normalised).equals(stagedHmac)) return "mismatch";
    await client.query("SAVEPOINT promote_email");
    try {
      const written = await client.query(
        `INSERT INTO principal_email_verifications (principal_id, email, verified, source)
         SELECT id, $2, true, 'legacy_import' FROM principals WHERE id = $1 AND email IS NOT NULL AND lower(btrim(email)) = $2
         ON CONFLICT (principal_id, email) DO NOTHING RETURNING 1`, [principalId, normalised]);
      await client.query("RELEASE SAVEPOINT promote_email");
      if (written.rowCount === 1) return "promoted";
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT promote_email");
      if ((error as { code?: string }).code === "23514") return "addressChanged";
      throw error;
    }
    const answered = await client.query("SELECT 1 FROM principal_email_verifications WHERE principal_id = $1 AND email = $2", [principalId, normalised]);
    return answered.rowCount ? "answered" : "addressChanged";
  }
}
