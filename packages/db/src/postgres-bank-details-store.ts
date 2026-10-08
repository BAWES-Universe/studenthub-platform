/**
 * SHU-182 (F1): the PostgreSQL store behind a candidate's own bank details.
 *
 * It binds the SHU-82 `SafeWriteStore` port to one field, `bank_details`, whose
 * value is the canonical JSON of bank, IBAN and beneficiary name. Every
 * precondition is re-checked inside one transaction together with the row and
 * the receipt, as SHU-84's language store does:
 *
 * - the grant lock PostgresAuthzStore takes for this principal serializes the
 *   candidate check with revocation;
 * - the token is single-use through a unique index on the receipt row;
 * - the row changes only if it still holds the value the preview showed;
 * - the bank must still be an active catalogue bank at commit time;
 * - the receipt is a SHU-59 ledger row carrying references and the field name only.
 *
 * This module is the only reader of `candidate_bank_details`; the
 * non-finance projection test keeps it that way.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import type { CommitInput, CommitOutcome, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import {
  BANK_DETAILS_FIELD, bankDetailsRecordRef, bankDetailsValue,
  candidateBankOwnerDecision, parseBankDetailsValue,
} from "@studenthub/pay-contracts";

import { principalAuditRef } from "./authorization-audit.js";
import { databaseUrl } from "./connection.js";

export const BANK_DETAILS_OPERATION = "candidate.bank_details.safe_write" as const;

const REFERENCE = /^[0-9a-f]{64}$/;
const tokenRef = (id: string) => createHash("sha256").update("studenthub:bank-details-token:v1\0").update(id).digest("hex");

function isInstant(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export interface PostgresBankDetailsStoreOptions {
  readonly connectionString?: string;
  readonly pool?: pg.Pool;
}

class Refusal extends Error {
  constructor(readonly reason: Exclude<CommitOutcome, { ok: true }>["reason"]) { super(reason); }
}

type Client = pg.Pool | pg.PoolClient;

export class PostgresBankDetailsStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;

  constructor(options: PostgresBankDetailsStoreOptions = {}) {
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
    const ownRecordRef = bankDetailsRecordRef(principalId);
    return {
      ownedRecord: async (principalRef) =>
        principalRef === ownPrincipalRef && await this.#isCandidate(this.#pool, principalId) ? ownRecordRef : null,
      readField: async (recordRef, field) =>
        recordRef === ownRecordRef && field === BANK_DETAILS_FIELD ? this.#read(this.#pool, principalId) : null,
      commit: async (input) =>
        input.principalRef === ownPrincipalRef && input.personRef === ownRecordRef
          ? this.#commit(principalId, input) : { ok: false, reason: "not_own_record" },
    };
  }

  /** The caller's own receipt, or null. A reference owned by someone else is indistinguishable from none. */
  async readReceipt(principalId: string, receiptRef: string): Promise<Receipt | null> {
    if (!REFERENCE.test(receiptRef)) return null;
    const principalRef = principalAuditRef(principalId);
    const { rows } = await this.#pool.query<{ actor_principal_ref: string | null; after_summary: Record<string, unknown> }>(
      `SELECT actor_principal_ref, after_summary FROM authorization_mutation_audit
        WHERE operation = $1 AND request_ref = $2 AND target_principal_ref = $3`,
      [BANK_DETAILS_OPERATION, receiptRef, principalRef],
    );
    const row = rows[0];
    if (!row) return null;
    const a = row.after_summary;
    // Fail closed: a row the database should have refused is never served as a receipt.
    if (row.actor_principal_ref !== principalRef || a?.personRef !== bankDetailsRecordRef(principalId)
      || typeof a.contractVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(a.contractVersion)
      || typeof a.changeSetDigest !== "string" || !REFERENCE.test(a.changeSetDigest)
      || !Array.isArray(a.fields) || a.fields.length !== 1 || a.fields[0] !== BANK_DETAILS_FIELD
      || !isInstant(a.committedAt)) {
      throw new Error("malformed bank details receipt");
    }
    return Object.freeze({
      contractVersion: a.contractVersion, receiptRef, personRef: a.personRef, principalRef,
      changeSetDigest: a.changeSetDigest, fields: Object.freeze([BANK_DETAILS_FIELD]), committedAt: a.committedAt as string,
    });
  }

  async #isCandidate(client: Client, principalId: string, lock = false): Promise<boolean> {
    const { rows } = await client.query<{ role: string }>(
      `SELECT role FROM grants WHERE principal_id = $1${lock ? " FOR SHARE" : ""}`, [principalId]);
    return candidateBankOwnerDecision(rows);
  }

  async #read(client: Client, principalId: string): Promise<string | null> {
    const { rows } = await client.query<{ bank_id: string; iban: string; beneficiary_name: string }>(
      "SELECT bank_id::text, iban, beneficiary_name FROM candidate_bank_details WHERE principal_id = $1", [principalId]);
    const row = rows[0];
    return row ? bankDetailsValue({ bankId: row.bank_id, iban: row.iban, beneficiaryName: row.beneficiary_name }) : null;
  }

  async #commit(principalId: string, input: CommitInput): Promise<CommitOutcome> {
    const { receipt } = input;
    const details = parseBankDetailsValue(input.value);
    if (input.field !== BANK_DETAILS_FIELD || details === undefined || receipt.personRef !== input.personRef
      || receipt.principalRef !== input.principalRef || receipt.changeSetDigest !== input.changeSetDigest
      || receipt.fields.length !== 1 || receipt.fields[0] !== BANK_DETAILS_FIELD) {
      // The contract builds these together; a mismatch is a programming error.
      throw new TypeError("inconsistent bank details commit");
    }
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
        [BANK_DETAILS_OPERATION, spentRef]);
      if (used.rows.length > 0) throw new Refusal("token_already_used");
      const current = await this.#read(client, principalId);
      if (current !== input.expectedBefore) throw new Refusal("state_changed");
      // The bank was active at preview and at confirm; it must still be at commit.
      const bank = await client.query<{ status: string }>(
        "SELECT status FROM catalogue_items WHERE catalogue_type = 'bank' AND id = $1::uuid FOR SHARE", [details.bankId]);
      if (bank.rows[0]?.status !== "active") throw new Refusal("state_changed");
      await client.query(
        `INSERT INTO candidate_bank_details (principal_id, bank_id, iban, beneficiary_name) VALUES ($1, $2::uuid, $3, $4)
         ON CONFLICT (principal_id) DO UPDATE SET bank_id = EXCLUDED.bank_id, iban = EXCLUDED.iban,
           beneficiary_name = EXCLUDED.beneficiary_name, updated_at = clock_timestamp()`,
        [principalId, details.bankId, details.iban, details.beneficiaryName]);
      await client.query(
        `INSERT INTO authorization_mutation_audit
           (request_ref, actor_principal_ref, operation, target_principal_ref, target_org_refs, before_summary, after_summary)
         VALUES ($1, $2, $3, $2, '{}'::text[], $4::jsonb, $5::jsonb)`,
        [receipt.receiptRef, receipt.principalRef, BANK_DETAILS_OPERATION,
          JSON.stringify({ valuePresent: current !== null }),
          JSON.stringify({
            contractVersion: receipt.contractVersion, personRef: receipt.personRef,
            changeSetDigest: receipt.changeSetDigest, fields: [BANK_DETAILS_FIELD],
            committedAt: receipt.committedAt, tokenRef: spentRef,
          })]);
      await client.query("COMMIT");
      return { ok: true };
    } catch (error) {
      // A failed ROLLBACK leaves the connection in an unknown state: drop it.
      await client.query("ROLLBACK").catch(() => { broken = true; });
      if (error instanceof Refusal) return { ok: false, reason: error.reason };
      // Either the token reference or its receipt may win a racing insert;
      // both mean this confirm has already been consumed.
      const { code, constraint } = error as { code?: string; constraint?: string };
      if (code === "23505" && (constraint === "authorization_mutation_audit_bank_details_token"
        || constraint === "authorization_mutation_audit_bank_details_receipt")) return { ok: false, reason: "token_already_used" };
      throw error;
    } finally {
      client.release(broken);
    }
  }
}
