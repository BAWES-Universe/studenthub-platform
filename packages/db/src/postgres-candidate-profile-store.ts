/**
 * SHU-143 (S2): the PostgreSQL store behind a candidate's own profile fields.
 *
 * It binds the SHU-82 `SafeWriteStore` port to the fourteen self-edit fields of
 * `candidate_profiles`, one field per write. Every precondition is re-checked in
 * one transaction together with the field, the completeness and the receipt:
 *
 * - the grant lock PostgresAuthzStore takes for this principal serializes the
 *   candidate check with revocation;
 * - the token is single-use through a unique index on the receipt row;
 * - the field changes only if it still holds the value the preview showed;
 * - a nationality or university must still be an active catalogue item at commit;
 * - a phone or profile URL taken by someone else since the preview is refused;
 * - completeness (`pending_fields`) is recomputed from the row as written;
 * - the receipt is a SHU-59 ledger row carrying references and the field name only.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import type { CommitInput, CommitOutcome, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import {
  candidateProfileOwnerDecision, candidateProfileRecordRef, pendingProfileRequirements, SELF_EDIT_FIELDS,
  type CompletenessFacts, type SelfEditField, type SelfEditReferences,
} from "@studenthub/profile";

import { principalAuditRef } from "./authorization-audit.js";
import { databaseUrl } from "./connection.js";

export const CANDIDATE_PROFILE_OPERATION = "candidate.profile.safe_write" as const;

/** How each field is read back as its canonical string, and the column it writes. */
const COLUMNS: Readonly<Record<SelfEditField, { readonly column: string; readonly read: string; readonly cast: string }>> = Object.freeze({
  display_name: { column: "display_name", read: "display_name", cast: "text" },
  arabic_name: { column: "arabic_name", read: "arabic_name", cast: "text" },
  gender: { column: "gender", read: "gender", cast: "text" },
  birth_date: { column: "birth_date", read: "to_char(birth_date, 'YYYY-MM-DD')", cast: "date" },
  nationality: { column: "nationality_id", read: "nationality_id::text", cast: "uuid" },
  kuwaiti_mother: { column: "kuwaiti_mother", read: "kuwaiti_mother::text", cast: "boolean" },
  university: { column: "university_id", read: "university_id::text", cast: "uuid" },
  objective: { column: "objective", read: "objective", cast: "text" },
  intro: { column: "intro", read: "intro", cast: "text" },
  preferred_time: { column: "preferred_time", read: "preferred_time", cast: "text" },
  profile_url: { column: "profile_url", read: "profile_url", cast: "text" },
  driving_licence: { column: "driving_licence", read: "driving_licence::text", cast: "boolean" },
  job_search_status: { column: "job_search_status", read: "job_search_status", cast: "text" },
  phone: { column: "phone", read: "phone", cast: "text" },
});
const CATALOGUE: Partial<Record<SelfEditField, "country" | "university">> = { nationality: "country", university: "university" };
const UNIQUE_INDEXES = new Set(["candidate_profiles_phone_uq", "candidate_profiles_profile_url_uq"]);
const TOKEN_INDEXES = new Set(["authorization_mutation_audit_candidate_profile_token", "authorization_mutation_audit_candidate_profile_receipt"]);

const REFERENCE = /^[0-9a-f]{64}$/;
const tokenRef = (id: string) => createHash("sha256").update("studenthub:candidate-profile-token:v1\0").update(id).digest("hex");
const isField = (field: string): field is SelfEditField => (SELF_EDIT_FIELDS as readonly string[]).includes(field);

function isInstant(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export interface PostgresCandidateProfileStoreOptions {
  readonly connectionString?: string;
  readonly pool?: pg.Pool;
}

class Refusal extends Error {
  constructor(readonly reason: Exclude<CommitOutcome, { ok: true }>["reason"]) { super(reason); }
}

type Client = pg.Pool | pg.PoolClient;

export class PostgresCandidateProfileStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;

  constructor(options: PostgresCandidateProfileStoreOptions = {}) {
    this.#ownsPool = options.pool === undefined;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  /** The port for one signed-in principal; it can reach that person's own row only. */
  forPrincipal(principalId: string): SafeWriteStore {
    if (typeof principalId !== "string" || principalId.length === 0) throw new TypeError("principal id required");
    const ownPrincipalRef = principalAuditRef(principalId);
    const ownRecordRef = candidateProfileRecordRef(principalId);
    return {
      ownedRecord: async (principalRef) =>
        principalRef === ownPrincipalRef && await this.#isCandidate(this.#pool, principalId) ? ownRecordRef : null,
      readField: async (recordRef, field) =>
        recordRef === ownRecordRef && isField(field) ? this.#read(this.#pool, principalId, field) : null,
      commit: async (input) =>
        input.principalRef === ownPrincipalRef && input.personRef === ownRecordRef
          ? this.#commit(principalId, input) : { ok: false, reason: "not_own_record" },
    };
  }

  /** The catalogue and uniqueness lookups the value check needs, as seen by one principal. */
  referencesFor(principalId: string): SelfEditReferences {
    return {
      activeCatalogueItem: async (type, id) => {
        const { rows } = await this.#pool.query(
          "SELECT 1 FROM catalogue_items WHERE catalogue_type = $1 AND id = $2::uuid AND status = 'active'", [type, id]);
        return rows.length === 1;
      },
      available: async (field, value) => {
        const { rows } = await this.#pool.query(
          `SELECT 1 FROM candidate_profiles WHERE ${COLUMNS[field].column} = $1 AND principal_id <> $2`, [value, principalId]);
        return rows.length === 0;
      },
    };
  }

  /** The caller's own receipt, or null. A reference owned by someone else is indistinguishable from none. */
  async readReceipt(principalId: string, receiptRef: string): Promise<Receipt | null> {
    if (!REFERENCE.test(receiptRef)) return null;
    const principalRef = principalAuditRef(principalId);
    const { rows } = await this.#pool.query<{ actor_principal_ref: string | null; after_summary: Record<string, unknown> }>(
      `SELECT actor_principal_ref, after_summary FROM authorization_mutation_audit
        WHERE operation = $1 AND request_ref = $2 AND target_principal_ref = $3`,
      [CANDIDATE_PROFILE_OPERATION, receiptRef, principalRef],
    );
    const row = rows[0];
    if (!row) return null;
    const a = row.after_summary;
    // Fail closed: a row the database should have refused is never served as a receipt.
    if (row.actor_principal_ref !== principalRef || a?.personRef !== candidateProfileRecordRef(principalId)
      || typeof a.contractVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(a.contractVersion)
      || typeof a.changeSetDigest !== "string" || !REFERENCE.test(a.changeSetDigest)
      || !Array.isArray(a.fields) || a.fields.length !== 1 || typeof a.fields[0] !== "string" || !isField(a.fields[0])
      || !isInstant(a.committedAt)) {
      throw new Error("malformed candidate profile receipt");
    }
    return Object.freeze({
      contractVersion: a.contractVersion, receiptRef, personRef: a.personRef, principalRef,
      changeSetDigest: a.changeSetDigest, fields: Object.freeze([a.fields[0]]), committedAt: a.committedAt as string,
    });
  }

  /** The completeness stored with the row, or null when the person has no row yet. */
  async readPending(principalId: string): Promise<readonly string[] | null> {
    const { rows } = await this.#pool.query<{ pending_fields: string[] }>(
      "SELECT pending_fields FROM candidate_profiles WHERE principal_id = $1", [principalId]);
    return rows[0] ? Object.freeze([...rows[0].pending_fields]) : null;
  }

  async #isCandidate(client: Client, principalId: string, lock = false): Promise<boolean> {
    const { rows } = await client.query<{ role: string }>(
      `SELECT role FROM grants WHERE principal_id = $1${lock ? " FOR SHARE" : ""}`, [principalId]);
    return candidateProfileOwnerDecision(rows);
  }

  async #read(client: Client, principalId: string, field: SelfEditField): Promise<string | null> {
    const { rows } = await client.query<{ value: string | null }>(
      `SELECT ${COLUMNS[field].read} AS value FROM candidate_profiles WHERE principal_id = $1`, [principalId]);
    return rows[0]?.value ?? null;
  }

  /**
   * What completeness depends on, read inside the commit. Documents, civil ID and
   * location are not yet held by the platform in a form this store can read, so they
   * count as missing: completeness can be too strict here, never too lenient.
   */
  async #facts(client: Client, principalId: string): Promise<CompletenessFacts> {
    const select = SELF_EDIT_FIELDS.map((field) => `${COLUMNS[field].read} AS "${field}"`).join(", ");
    const row = await client.query<Record<SelfEditField, string | null>>(
      `SELECT ${select} FROM candidate_profiles WHERE principal_id = $1`, [principalId]);
    const email = await client.query<{ email: string | null }>("SELECT email FROM principals WHERE id = $1", [principalId]);
    const records = await client.query<{ kind: string; n: number }>(
      `SELECT kind, count(*)::int AS n FROM candidate_profile_records
        WHERE owner_principal_id = $1 AND status = 'active' GROUP BY kind`, [principalId]);
    const count = (kind: string) => records.rows.find((r) => r.kind === kind)?.n ?? 0;
    return {
      fields: row.rows[0] ?? {},
      emailRecorded: typeof email.rows[0]?.email === "string" && email.rows[0].email.length > 0,
      personalPhoto: false, civilId: false, civilExpiry: false, civilFront: false, civilBack: false,
      location: undefined, nationalityKuwaiti: undefined,
      educationCount: count("education"), skillCount: count("skill"),
    };
  }

  async #commit(principalId: string, input: CommitInput): Promise<CommitOutcome> {
    const { receipt } = input;
    if (!isField(input.field) || receipt.personRef !== input.personRef || receipt.principalRef !== input.principalRef
      || receipt.changeSetDigest !== input.changeSetDigest || receipt.fields.length !== 1 || receipt.fields[0] !== input.field) {
      // The contract builds these together; a mismatch is a programming error.
      throw new TypeError("inconsistent candidate profile commit");
    }
    const field = input.field;
    const { column, cast } = COLUMNS[field];
    const spentRef = tokenRef(input.tokenId);
    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      // The lock PostgresAuthzStore takes for this principal's grant mutations.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 5959))", [principalId]);
      if (!await this.#isCandidate(client, principalId, true)) throw new Refusal("not_own_record");
      const used = await client.query(
        "SELECT 1 FROM authorization_mutation_audit WHERE operation = $1 AND after_summary ->> 'tokenRef' = $2",
        [CANDIDATE_PROFILE_OPERATION, spentRef]);
      if (used.rows.length > 0) throw new Refusal("token_already_used");
      const current = await this.#read(client, principalId, field);
      if (current !== input.expectedBefore) throw new Refusal("state_changed");
      const catalogue = CATALOGUE[field];
      if (catalogue) {
        // Active at preview and at confirm; it must still be at commit.
        const item = await client.query<{ status: string }>(
          "SELECT status FROM catalogue_items WHERE catalogue_type = $1 AND id = $2::uuid FOR SHARE", [catalogue, input.value]);
        if (item.rows[0]?.status !== "active") throw new Refusal("state_changed");
      }
      const searchStamp = field === "job_search_status" ? ", job_search_updated_at = clock_timestamp()" : "";
      await client.query(
        `INSERT INTO candidate_profiles (principal_id, ${column}, pending_fields${field === "job_search_status" ? ", job_search_updated_at" : ""})
         VALUES ($1, $2::${cast}, '{}'::text[]${field === "job_search_status" ? ", clock_timestamp()" : ""})
         ON CONFLICT (principal_id) DO UPDATE SET ${column} = EXCLUDED.${column}${searchStamp}, updated_at = clock_timestamp()`,
        [principalId, input.value]);
      const pending = pendingProfileRequirements(await this.#facts(client, principalId));
      await client.query("UPDATE candidate_profiles SET pending_fields = $2::text[] WHERE principal_id = $1", [principalId, pending]);
      await client.query(
        `INSERT INTO authorization_mutation_audit
           (request_ref, actor_principal_ref, operation, target_principal_ref, target_org_refs, before_summary, after_summary)
         VALUES ($1, $2, $3, $2, '{}'::text[], $4::jsonb, $5::jsonb)`,
        [receipt.receiptRef, receipt.principalRef, CANDIDATE_PROFILE_OPERATION,
          JSON.stringify({ valuePresent: current !== null }),
          JSON.stringify({
            contractVersion: receipt.contractVersion, personRef: receipt.personRef,
            changeSetDigest: receipt.changeSetDigest, fields: [field],
            committedAt: receipt.committedAt, tokenRef: spentRef,
          })]);
      await client.query("COMMIT");
      return { ok: true };
    } catch (error) {
      // A failed ROLLBACK leaves the connection in an unknown state: drop it.
      await client.query("ROLLBACK").catch(() => { broken = true; });
      if (error instanceof Refusal) return { ok: false, reason: error.reason };
      const { code, constraint } = error as { code?: string; constraint?: string };
      // Someone else took this phone or profile URL after the preview.
      if (code === "23505" && constraint !== undefined && UNIQUE_INDEXES.has(constraint)) return { ok: false, reason: "state_changed" };
      // Either the token reference or its receipt may win a racing insert; both mean this confirm was consumed.
      if (code === "23505" && constraint !== undefined && TOKEN_INDEXES.has(constraint)) return { ok: false, reason: "token_already_used" };
      throw error;
    } finally {
      client.release(broken);
    }
  }
}
