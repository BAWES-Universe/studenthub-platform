import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { browserBaselineDigest, browserChangeSetDigest, browserFirstWriteExpired, BROWSER_WRITE_VERSION, type BrowserBaseline, type BrowserWriteAPI, type BrowserWriteBinding, type BrowserWriteToken, type BrowserWriteOutcome, type BrowserReceiptStatus, type createBrowserWriteTokens } from "@studenthub/safe-write-contract";
import type { CommitInput, CommitOutcome, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import { principalAuditRef } from "./authorization-audit.js";
import { databaseUrl } from "./connection.js";
import { personRecordRef, SAFE_WRITE_OPERATION, safeWritePrincipalRef } from "./safe-write-store.js";

export const PERSON_PROFILE_FIELDS = ["displayName", "arabicName", "objective", "intro", "preferredTime", "gender", "birthDate", "drivingLicence", "jobSearchStatus", "phone", "handle", "nationality", "university", "kuwaitiMother"] as const;
export type PersonProfileField = (typeof PERSON_PROFILE_FIELDS)[number];
const COLUMNS: Record<PersonProfileField, string> = {
  displayName: "display_name", arabicName: "arabic_name", objective: "objective", intro: "introduction", preferredTime: "preferred_time",
  gender: "gender", birthDate: "birth_date", drivingLicence: "driving_licence", jobSearchStatus: "job_search_status",
  phone: "phone", handle: "profile_handle",
  nationality: "nationality_id", university: "university_id", kuwaitiMother: "kuwaiti_mother",
};
const REFERENCE = /^[0-9a-f]{64}$/;
const tokenRef = (value: string) => createHash("sha256").update("studenthub:safe-write-token-ref:v1\0").update(value).digest("hex");

class Refusal extends Error { constructor(readonly reason: Exclude<CommitOutcome, { ok: true }>["reason"]) { super(reason); } }

/** Implementations must be SELECT-only and use this transaction, not a pool/housekeeping read. */
export interface PersonProfileSessionLiveness {
  read(client: pg.PoolClient, sessionToken: string): Promise<string | undefined>;
}
/** Re-read the approved displayed value after the lock, not merely an import revision.
 * The approved source is a batch-loaded read-only snapshot; this port does not
 * freeze an external source through COMMIT. Throw if source evidence is unavailable.
 */
export interface PersonProfileImportedFallback {
  read(principalId: string, field: PersonProfileField): Promise<BrowserBaseline["shownFallback"]>;
}
export interface PersonProfileBrowserOptions {
  readonly principalId: string;
  readonly sessionToken: string;
  readonly tokens: ReturnType<typeof createBrowserWriteTokens>;
  readonly normalizationVersion: string;
  readonly sessionLiveness: PersonProfileSessionLiveness;
  readonly importedFallback: PersonProfileImportedFallback;
}
/** The transaction never reached COMMIT. Explicit retry may reuse the same token/payload. */
export class PersonProfileBrowserRetryableError extends Error {
  constructor(options?: ErrorOptions) { super("Profile save rolled back; retry the same operation", options); this.name = "PersonProfileBrowserRetryableError"; }
}
class BrowserCanonicalValueError extends TypeError {}
class BrowserRefusal extends Error {
  constructor(readonly status: "not_authorized" | "state_changed" | "expired") { super(status); }
}

export class PostgresPersonProfileStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;
  constructor(options: { readonly connectionString?: string; readonly pool?: pg.Pool } = {}) {
    this.#ownsPool = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close() { if (this.#ownsPool) await this.#pool.end(); }

  async contactValueAvailable(principalId: string, field: "phone" | "handle", value: string): Promise<boolean> {
    const column = COLUMNS[field];
    const { rows } = await this.#pool.query(`SELECT NOT EXISTS (SELECT 1 FROM person_profiles WHERE ${column}=$1 AND principal_id<>$2) AS available`, [value, principalId]);
    return rows[0]?.available === true;
  }

  async originValueAvailable(principalId: string, field: "nationality" | "university" | "kuwaitiMother", value: string): Promise<boolean> {
    if (field === "university" && value === "") return true;
    if (field === "kuwaitiMother") {
      if (value !== "" && value !== "true" && value !== "false") return false;
      const { rows } = await this.#pool.query(`SELECT NOT EXISTS (SELECT 1 FROM person_profiles pp JOIN catalogue_items c ON c.id=pp.nationality_id WHERE pp.principal_id=$1 AND c.catalogue_type='country' AND c.code='KW') AS available`, [principalId]);
      return rows[0]?.available === true;
    }
    const type = field === "nationality" ? "country" : "university";
    const { rows } = await this.#pool.query(`SELECT EXISTS (SELECT 1 FROM catalogue_items WHERE id=$1 AND catalogue_type=$2 AND status='active') AS available`, [value, type]);
    return rows[0]?.available === true;
  }

  async readOriginChoices() {
    const { rows } = await this.#pool.query(`SELECT id::text,name,code,catalogue_type FROM catalogue_items WHERE status='active' AND catalogue_type IN ('country','university') ORDER BY catalogue_type,normalized_name COLLATE "C",id`);
    return Object.freeze({
      countries: Object.freeze(rows.filter(row => row.catalogue_type === "country").map(row => Object.freeze({ id: row.id as string, name: row.name as string, code: row.code as string | null }))),
      universities: Object.freeze(rows.filter(row => row.catalogue_type === "university").map(row => Object.freeze({ id: row.id as string, name: row.name as string }))),
    });
  }

  forPrincipal(principalId: string): SafeWriteStore {
    if (!principalId) throw new TypeError("principal id required");
    const principalRef = safeWritePrincipalRef(principalId), personRef = personRecordRef(principalId);
    return {
      contactValueAvailable: (field: "phone" | "handle", value: string) => this.contactValueAvailable(principalId, field, value),
      originValueAvailable: (field: "nationality" | "university" | "kuwaitiMother", value: string) => this.originValueAvailable(principalId, field, value),
      ownedRecord: async ref => ref === principalRef && await this.#exists(this.#pool, principalId) ? personRef : null,
      readField: async (record, field) => record === personRef && PERSON_PROFILE_FIELDS.includes(field as PersonProfileField)
        ? this.#readField(principalId, field as PersonProfileField) : null,
      commit: async input => input.principalRef === principalRef && input.personRef === personRef
        ? this.#commit(principalId, input) : { ok: false, reason: "not_own_record" },
    } as SafeWriteStore;
  }

  async readOwnPreferences(principalId: string) {
    if (!principalId) throw new TypeError("principal id required");
    const { rows } = await this.#pool.query(
      `SELECT pp.display_name, pp.display_name_written_at, pp.arabic_name, pp.arabic_name_written_at,
              pp.objective, pp.objective_written_at, pp.introduction, pp.introduction_written_at,
              pp.preferred_time, pp.preferred_time_written_at,
              pp.gender::text, pp.gender_written_at, pp.birth_date::text, pp.birth_date_written_at,
              pp.driving_licence::text, pp.driving_licence_written_at,
              pp.job_search_status::text, pp.job_search_status_written_at,
              pp.phone::text, pp.phone_written_at, pp.profile_handle::text, pp.profile_handle_written_at
              ,pp.nationality_id::text, pp.nationality_id_written_at, nationality.name AS nationality_name
              ,pp.university_id::text, pp.university_id_written_at, university.name AS university_name
              ,pp.kuwaiti_mother::text, pp.kuwaiti_mother_written_at
         FROM principals p LEFT JOIN person_profiles pp ON pp.principal_id=p.id
         LEFT JOIN catalogue_items nationality ON nationality.id=pp.nationality_id AND nationality.catalogue_type='country'
         LEFT JOIN catalogue_items university ON university.id=pp.university_id AND university.catalogue_type='university'
         WHERE p.id=$1`, [principalId]);
    const row = rows[0];
    if (!row) return null;
    const result: Record<string, unknown> = {};
    for (const [field, column] of Object.entries(COLUMNS)) {
      const at = row[`${column}_written_at`];
      if (at instanceof Date) result[field] = Object.freeze({ value: field === "nationality" ? row.nationality_name : field === "university" ? row.university_name : row[column], updatedAt: at.toISOString(), ...((field === "nationality" || field === "university") && row[column] !== null ? { editValue: row[column] } : {}) });
    }
    return Object.freeze(result);
  }

  async readReceipt(principalId: string, receiptRef: string): Promise<Receipt | null> {
    if (!REFERENCE.test(receiptRef)) return null;
    const { rows } = await this.#pool.query(`SELECT request_ref, actor_principal_ref, after_summary FROM authorization_mutation_audit
      WHERE operation=$1 AND request_ref=$2 AND target_principal_ref=$3`, [SAFE_WRITE_OPERATION, receiptRef, safeWritePrincipalRef(principalId)]);
    const row = rows[0], field = row?.after_summary?.fields?.[0];
    if (!row || !PERSON_PROFILE_FIELDS.includes(field)) return null;
    const receipt = { contractVersion: row.after_summary.contractVersion, receiptRef: row.request_ref,
      personRef: row.after_summary.personRef, principalRef: row.actor_principal_ref,
      changeSetDigest: row.after_summary.changeSetDigest, fields: [field], committedAt: row.after_summary.committedAt };
    if (receipt.personRef !== personRecordRef(principalId) || receipt.principalRef !== principalAuditRef(principalId)
      || !REFERENCE.test(receipt.changeSetDigest)) throw new Error("malformed safe-write receipt");
    return Object.freeze(receipt);
  }

  /** No route is installed here. U2b supplies the real adapters and validated canonical values. */
  forBrowserSession(options: PersonProfileBrowserOptions): {
    issue(field: PersonProfileField): Promise<BrowserWriteToken>;
    save(input: Parameters<BrowserWriteAPI["save"]>[0]): Promise<BrowserWriteOutcome>;
    receiptStatus(token: BrowserWriteToken): Promise<BrowserReceiptStatus>;
  } {
    if (!options.principalId || !options.sessionToken || !options.normalizationVersion) throw new TypeError("Browser session binding required");
    options = Object.freeze({ ...options });
    return Object.freeze({
      issue: (field: PersonProfileField) => this.#issueBrowser(options, field),
      save: (input: { token: BrowserWriteToken; canonicalValue: string | boolean | null }) => this.#saveBrowser(options, input),
      receiptStatus: (token: BrowserWriteToken) => this.#browserReceiptStatus(options, token),
    });
  }

  #browserBinding(options: PersonProfileBrowserOptions, field: string): BrowserWriteBinding {
    return { principalRef: safeWritePrincipalRef(options.principalId), personRef: personRecordRef(options.principalId), field,
      normalizationVersion: options.normalizationVersion };
  }
  #verifyBrowser(options: PersonProfileBrowserOptions, token: BrowserWriteToken) {
    if (!PERSON_PROFILE_FIELDS.includes(token?.field as PersonProfileField)) return { ok: false as const, reason: "invalid_token" as const };
    return options.tokens.verify(token, this.#browserBinding(options, token.field));
  }
  async #authorizeBrowser(client: pg.PoolClient, options: PersonProfileBrowserOptions) {
    if (await options.sessionLiveness.read(client, options.sessionToken) !== options.principalId) throw new BrowserRefusal("not_authorized");
  }
  async #lockBrowser(client: pg.PoolClient, options: PersonProfileBrowserOptions) {
    await this.#authorizeBrowser(client, options);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 5959))", [options.principalId]);
    // READ COMMITTED: a revocation committed while waiting must be visible here.
    await this.#authorizeBrowser(client, options);
  }
  async #browserBaseline(client: pg.PoolClient, options: PersonProfileBrowserOptions, field: PersonProfileField, lockRow = false): Promise<BrowserBaseline> {
    const column = COLUMNS[field];
    const row = (await client.query(`SELECT ${column}::text AS value, ${column}_written_at AS written_at FROM person_profiles WHERE principal_id=$1${lockRow ? " FOR UPDATE" : ""}`, [options.principalId])).rows[0];
    // A cleared (NULL) override is still written and hides the imported value.
    const shownFallback = row?.written_at ? null : await options.importedFallback.read(options.principalId, field);
    return { persisted: row?.value == null ? { kind: "null" } : { kind: "present", value: row.value }, shownFallback };
  }
  async #issueBrowser(options: PersonProfileBrowserOptions, field: PersonProfileField): Promise<BrowserWriteToken> {
    if (!PERSON_PROFILE_FIELDS.includes(field)) throw new TypeError("Unsupported profile field");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
      await this.#lockBrowser(client, options);
      if (!await this.#exists(client, options.principalId)) throw new BrowserRefusal("not_authorized");
      const baseline = await this.#browserBaseline(client, options, field);
      // Issuance and expiry use the same DB clock; app-clock skew is irrelevant.
      const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
      const token = options.tokens.issue(this.#browserBinding(options, field), browserBaselineDigest(baseline), now);
      await client.query("COMMIT");
      return token;
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
    finally { client.release(); }
  }
  async #findBrowserReceipt(client: pg.PoolClient, options: PersonProfileBrowserOptions, token: BrowserWriteToken): Promise<Receipt | null> {
    const row = (await client.query(`SELECT request_ref, actor_principal_ref, after_summary FROM authorization_mutation_audit
      WHERE operation=$1 AND after_summary->>'tokenRef'=$2 AND target_principal_ref=$3`,
      [SAFE_WRITE_OPERATION, token.tokenRef, safeWritePrincipalRef(options.principalId)])).rows[0];
    if (!row) return null;
    const summary = row.after_summary;
    if (summary.contractVersion !== BROWSER_WRITE_VERSION || summary.personRef !== token.personRef || row.actor_principal_ref !== token.principalRef ||
        summary.fields?.length !== 1 || summary.fields[0] !== token.field || !REFERENCE.test(summary.changeSetDigest)) throw new Error("Malformed browser receipt");
    return Object.freeze({ contractVersion: summary.contractVersion, receiptRef: row.request_ref, principalRef: row.actor_principal_ref,
      personRef: summary.personRef, changeSetDigest: summary.changeSetDigest, fields: Object.freeze([...summary.fields]), committedAt: summary.committedAt });
  }
  async #browserReceiptStatus(options: PersonProfileBrowserOptions, token: BrowserWriteToken): Promise<BrowserReceiptStatus> {
    const verified = this.#verifyBrowser(options, token);
    if (!verified.ok) return { status: verified.reason === "recovery_unavailable" ? "recovery_unavailable" : "not_authorized" };
    let client: pg.PoolClient;
    try { client = await this.#pool.connect(); } catch { return { status: "unknown" }; }
    try {
      // PostgreSQL itself enforces the no-write invariant, including injected ports.
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
      await this.#lockBrowser(client, options);
      const receipt = await this.#findBrowserReceipt(client, options, verified.token);
      await client.query("COMMIT");
      return receipt ? { status: "committed", receipt } : { status: "not_found" };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      return { status: error instanceof BrowserRefusal ? error.status as "not_authorized" : "unknown" };
    } finally { client.release(); }
  }
  async #saveBrowser(options: PersonProfileBrowserOptions, input: { token: BrowserWriteToken; canonicalValue: string | boolean | null }, dedupeRetry = false): Promise<BrowserWriteOutcome> {
    const verified = this.#verifyBrowser(options, input.token);
    if (!verified.ok) return { status: verified.reason === "recovery_unavailable" ? "recovery_unavailable" : "not_authorized" };
    const token = verified.token, field = token.field as PersonProfileField, canonicalValue = input.canonicalValue;
    const changeSetDigest = browserChangeSetDigest(token, canonicalValue);
    let client: pg.PoolClient;
    try { client = await this.#pool.connect(); } catch (error) { throw new PersonProfileBrowserRetryableError({ cause: error }); }
    let committing = false, discard = false, retryDedupe = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await this.#lockBrowser(client, options);
      const receipt = await this.#findBrowserReceipt(client, options, token);
      if (receipt) {
        await client.query("ROLLBACK");
        return receipt.changeSetDigest === changeSetDigest ? { status: "already_committed", receipt } : { status: "token_payload_mismatch" };
      }
      const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
      if (browserFirstWriteExpired(token, now)) throw new BrowserRefusal("expired");
      if (!await this.#exists(client, options.principalId)) throw new BrowserRefusal("not_authorized");
      const baseline = await this.#browserBaseline(client, options, field, true);
      if (browserBaselineDigest(baseline) !== token.baselineDigest) throw new BrowserRefusal("state_changed");
      // Profile normalization uses strings exclusively: empty clears and booleans use
      // "true"/"false". U2b reconstructs receipts with the same representation.
      // Replay comparison above still refuses a different payload before this guard.
      if (typeof canonicalValue !== "string") throw new BrowserCanonicalValueError("Profile canonical value must be a validator-produced string");
      const value = canonicalValue;
      await this.#writeValue(client, options.principalId, field, value);
      const committedAt = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.toISOString();
      const newReceipt: Receipt = Object.freeze({ contractVersion: BROWSER_WRITE_VERSION, receiptRef: randomBytes(32).toString("hex"),
        personRef: token.personRef, principalRef: token.principalRef, changeSetDigest, fields: Object.freeze([field]), committedAt });
      await client.query(`INSERT INTO authorization_mutation_audit (request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary)
        VALUES ($1,$2,$3,$2,'{}',$4::jsonb,$5::jsonb)`, [newReceipt.receiptRef, token.principalRef, SAFE_WRITE_OPERATION,
        JSON.stringify({ valuePresent: baseline.persisted.kind === "present" }), JSON.stringify({ contractVersion: newReceipt.contractVersion, personRef: token.personRef,
          changeSetDigest, fields: [field], committedAt, tokenRef: token.tokenRef })]);
      committing = true;
      await client.query("COMMIT");
      return { status: "committed", receipt: newReceipt };
    } catch (error) {
      const databaseError = error as { code?: unknown; constraint?: unknown };
      const tokenConflict = databaseError.code === "23505" && databaseError.constraint === "authorization_mutation_audit_safe_write_token";
      if (committing && !tokenConflict) { discard = true; return { status: "unknown" }; }
      try { await client.query("ROLLBACK"); } catch { discard = true; }
      if (error instanceof BrowserRefusal) return { status: error.status };
      if (error instanceof BrowserCanonicalValueError) throw error;
      if (tokenConflict && !dedupeRetry && !discard) retryDedupe = true;
      else if (error instanceof Refusal) return { status: "state_changed" };
      else throw new PersonProfileBrowserRetryableError({ cause: error });
    } finally { client.release(discard); }
    if (retryDedupe) return this.#saveBrowser(options, { token, canonicalValue }, true);
    throw new PersonProfileBrowserRetryableError();
  }

  async #writeValue(client: pg.PoolClient, id: string, field: PersonProfileField, value: string) {
    const column = COLUMNS[field];
    if (field === "nationality" || field === "university") {
      if (field === "university" && value === "") { /* None is stored as NULL without a UUID lookup. */ }
      else {
        const type = field === "nationality" ? "country" : "university";
        const selected = (await client.query(`SELECT code FROM catalogue_items WHERE id=$1 AND catalogue_type=$2 AND status='active'`, [value, type])).rows[0];
        if (!selected) throw new Refusal("invalid_value");
        if (field === "nationality" && selected.code === "KW") await client.query(`UPDATE person_profiles SET kuwaiti_mother=NULL, kuwaiti_mother_written_at=NULL WHERE principal_id=$1`, [id]);
      }
    }
    if (field === "kuwaitiMother") {
      const kuwaiti = (await client.query(`SELECT 1 FROM person_profiles pp JOIN catalogue_items c ON c.id=pp.nationality_id WHERE pp.principal_id=$1 AND c.catalogue_type='country' AND c.code='KW'`, [id])).rows.length > 0;
      if (kuwaiti) throw new Refusal("invalid_value");
    }
    await client.query(`INSERT INTO person_profiles (principal_id, ${column}, ${column}_written_at) VALUES ($1,$2,clock_timestamp())
      ON CONFLICT (principal_id) DO UPDATE SET ${column}=EXCLUDED.${column}, ${column}_written_at=EXCLUDED.${column}_written_at`, [id, value === "" ? null : value]);
  }

  async #exists(client: pg.Pool | pg.PoolClient, id: string) { return (await client.query("SELECT 1 FROM principals WHERE id=$1", [id])).rows.length === 1; }
  async #readField(id: string, field: PersonProfileField) {
    const { rows } = await this.#pool.query(`SELECT ${COLUMNS[field]}::text AS value FROM person_profiles WHERE principal_id=$1`, [id]);
    return rows[0]?.value ?? null;
  }
  async #commit(id: string, input: CommitInput): Promise<CommitOutcome> {
    const field = input.field as PersonProfileField, column = COLUMNS[field];
    if (!column || input.receipt.personRef !== input.personRef || input.receipt.principalRef !== input.principalRef
      || input.receipt.changeSetDigest !== input.changeSetDigest || input.receipt.fields.length !== 1 || input.receipt.fields[0] !== field)
      throw new TypeError("inconsistent safe-write commit");
    const client = await this.#pool.connect(), spent = tokenRef(input.tokenId);
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 5959))", [id]);
      if ((await client.query(`SELECT 1 FROM authorization_mutation_audit WHERE operation=$1 AND after_summary->>'tokenRef'=$2`, [SAFE_WRITE_OPERATION, spent])).rows.length) throw new Refusal("token_already_used");
      if (!await this.#exists(client, id)) throw new Refusal("not_own_record");
      const current = (await client.query(`SELECT ${column}::text AS value FROM person_profiles WHERE principal_id=$1 FOR UPDATE`, [id])).rows[0]?.value ?? null;
      if (current !== input.expectedBefore) throw new Refusal("state_changed");
      await this.#writeValue(client, id, field, input.value);
      await client.query(`INSERT INTO authorization_mutation_audit (request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary)
        VALUES ($1,$2,$3,$2,'{}',$4::jsonb,$5::jsonb)`, [input.receipt.receiptRef, input.receipt.principalRef, SAFE_WRITE_OPERATION,
        JSON.stringify({ valuePresent: current !== null }), JSON.stringify({ contractVersion: input.receipt.contractVersion, personRef: input.receipt.personRef,
          changeSetDigest: input.receipt.changeSetDigest, fields: [field], committedAt: input.receipt.committedAt, tokenRef: spent })]);
      await client.query("COMMIT"); return { ok: true };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      if (error instanceof Refusal) return { ok: false, reason: error.reason };
      const databaseError = error as { code?: unknown; constraint?: unknown };
      if (databaseError.code === "23505" && databaseError.constraint === "authorization_mutation_audit_safe_write_token") {
        return { ok: false, reason: "token_already_used" };
      }
      if (databaseError.code === "23505" && ["person_profiles_phone_uq", "person_profiles_profile_handle_uq"].includes(String(databaseError.constraint))) return { ok: false, reason: "invalid_value" };
      if (databaseError.code === "23514") return { ok: false, reason: "invalid_value" };
      throw error;
    }
    finally { client.release(); }
  }
}
