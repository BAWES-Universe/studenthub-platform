// Cutover lane M-1, contact slice: the promotion step. For a person linked to a legacy candidate
// (legacy_account_links), it moves that candidate's staged values (legacy_candidate_contacts) into
// the person-owned tables, and only where the person has written nothing:
//
// - phone and profile handle into person_profiles, only while the field's written_at is null (a
//   cleared value is still written, so a person's clear is never undone);
// - the civil ID into person_civil_ids, only when the person has no civil ID row at all (released
//   included), opened from its legacy-candidate binding and re-sealed to the principal;
// - the verified address into principal_email_verifications (verified true, source
//   legacy_import), only when the person's current principals.email, read with the principal row
//   locked FOR SHARE until commit, normalises in JavaScript to the database's principal_email_key
//   for it (migration 0658, one ASCII-only, locale-independent rule for insert, cleanup and read)
//   and hashes to the staged HMAC. ON CONFLICT DO NOTHING, so an OIDC answer, true or false,
//   always wins. A refusal by the access lane's trigger is recorded as addressChanged.
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
 * address is outside the ASCII form, has none, or the JavaScript and database keys disagree.
 * addressChanged: the access lane's trigger refused the insert (not expected while the principal
 * row is locked; kept as a fail-closed outcome).
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

  /**
   * Linked principals with a staged row and no promotion yet, in id order (COLLATE "C"), strictly
   * after `after` when given. A caller walks the whole set by passing the last id it was given, so
   * a principal that stays pending (skipped, say) never stops the walk.
   */
  async pending(limit = 500, after?: string): Promise<readonly string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError("limit must be 1 to 10000");
    if (after !== undefined && (typeof after !== "string" || !PRINCIPAL.test(after))) throw new TypeError("after must be a principal id");
    try {
      const { rows } = await this.#pool.query<{ principal_id: string }>(
        `SELECT l.principal_id FROM legacy_account_links l
           JOIN legacy_candidate_contacts c ON c.legacy_candidate_id = l.legacy_candidate_id
          WHERE NOT EXISTS (SELECT 1 FROM legacy_contact_promotions p WHERE p.principal_id = l.principal_id)
            AND ($2::text IS NULL OR l.principal_id COLLATE "C" > $2::text COLLATE "C")
          ORDER BY l.principal_id COLLATE "C" LIMIT $1`, [limit, after ?? null]);
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
    // FOR SHARE: the address cannot change between this decision and commit; an address change
    // waits for this transaction (or this read waits for the change and sees the new address).
    const row = (await client.query<{ email: string | null; key: string | null }>(
      "SELECT email, principal_email_key(email) AS key FROM principals WHERE id = $1 FOR SHARE", [principalId])).rows[0];
    // The same JavaScript rule the address was staged under, and the database's own key for the
    // locked row (migration 0658, the rule Access inserts, cleans up and reads by) must agree.
    const normalised = row?.email == null ? null : normaliseVerifiedEmail(row.email);
    if (normalised === null || row?.key !== normalised) return "unverifiable";
    if (!this.#emails.emailDigest(normalised).equals(stagedHmac)) return "mismatch";
    await client.query("SAVEPOINT promote_email");
    try {
      const written = await client.query(
        `INSERT INTO principal_email_verifications (principal_id, email, verified, source)
         VALUES ($1, $2, true, 'legacy_import') ON CONFLICT (principal_id, email) DO NOTHING RETURNING 1`, [principalId, normalised]);
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
