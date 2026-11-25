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
}

/** What the store needs from CivilIdVault (packages/profile); structural, so db does not depend on profile. */
export interface CivilIdSealer {
  readonly keyVersion: number;
  seal(ref: string, country: "KW" | "BH", number: string): { readonly ciphertext: Buffer; readonly hash: Buffer; readonly keyVersion: number };
}

/** invalid: off the contract. duplicate: another staged candidate already holds the phone, handle or civil ID. */
export type PersonContactImportRefusal = "invalid" | "duplicate";

export interface PersonContactImportResult {
  readonly inserted: number;
  readonly unchanged: number;
  readonly conflicts: readonly { readonly legacyId: string }[];
  readonly refused: readonly { readonly legacyId: string; readonly code: PersonContactImportRefusal }[];
}

const KEYS = ["civilId", "civilIdNeedsReview", "handle", "legacyId", "phone"];
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
  return r.phone !== null || r.handle !== null || r.civilId !== null;
}

const refusalOf = (e: unknown): PersonContactImportRefusal | null => {
  const code = (e as { code?: string }).code ?? "";
  if (code === "23505") return "duplicate";
  return ["23514", "22P02"].includes(code) ? "invalid" : null;
};

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

  /** HMAC over the row's id and values; never a value-revealing hash. */
  digest(row: PersonContactImportRow): string {
    const civil = row.civilId ? [row.civilId.country, row.civilId.number] : null;
    return createHmac("sha256", this.#digestKey)
      .update(JSON.stringify(["m1-contact-v1", row.legacyId, row.phone, row.handle, civil, row.civilIdNeedsReview]))
      .digest("hex");
  }

  async importContacts(rows: readonly PersonContactImportRow[]): Promise<PersonContactImportResult> {
    let inserted = 0, unchanged = 0;
    const conflicts: { legacyId: string }[] = [];
    const refused: { legacyId: string; code: PersonContactImportRefusal }[] = [];
    const client = await this.#pool.connect();
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
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async #importOne(client: PoolClient, row: PersonContactImportRow): Promise<"inserted" | "unchanged" | "conflict"> {
    const digest = this.digest(row);
    const { rows: held } = await client.query<{ digest: string }>(
      "SELECT digest FROM legacy_candidate_contacts WHERE legacy_candidate_id = $1 FOR UPDATE", [row.legacyId]);
    if (held[0]) return held[0].digest === digest ? "unchanged" : "conflict";
    const sealed = row.civilId ? this.#sealer.seal(legacyCivilIdRef(row.legacyId), row.civilId.country, row.civilId.number) : null;
    await client.query(
      `INSERT INTO legacy_candidate_contacts (legacy_candidate_id, phone, profile_handle, civil_country, civil_number_ciphertext,
         civil_number_hash, civil_key_version, civil_needs_review, digest) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [row.legacyId, row.phone, row.handle, row.civilId?.country ?? null, sealed?.ciphertext ?? null, sealed?.hash ?? null,
        sealed?.keyVersion ?? null, row.civilId ? row.civilIdNeedsReview : null, digest]);
    return "inserted";
  }

  /** Legacy candidate ids with values against the staged rows; reported skips listed apart from unexplained gaps. */
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
