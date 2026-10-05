/**
 * SHU-84: the PostgreSQL store behind the platform's first safe write.
 *
 * It binds SHU-82's `SafeWriteStore` port to one field SHU-83 permits: the
 * person's language preference, owned by the platform and written only to the
 * platform database. Every precondition the contract assigns to the store is
 * checked inside one transaction, together with the field and the receipt:
 *
 * - the principal's grant mutations are serialized with this commit by the
 *   same advisory lock PostgresAuthzStore takes, so a revocation either lands
 *   before the ownership check or after the commit, never between them;
 * - the token is single-use through a unique index on the receipt row, which
 *   holds across processes and restarts;
 * - the field changes only if it still holds the value the preview showed;
 * - the receipt is a row in SHU-59's append-only authorization_mutation_audit,
 *   inserted in the same transaction, so a receipt failure undoes the field.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import type {
  CommitInput,
  CommitOutcome,
  Receipt,
  SafeWriteStore,
} from "@studenthub/safe-write-contract";

import { principalAuditRef } from "./authorization-audit.js";
import { databaseUrl } from "./connection.js";

export const SAFE_WRITE_OPERATION = "profile.safe_write" as const;
/** SHU-83: the only field the first safe write may change. */
export const LANGUAGE_FIELD = "language" as const;
export const LANGUAGES = ["en", "ar"] as const;
export type Language = (typeof LANGUAGES)[number];

const REFERENCE = /^[0-9a-f]{64}$/;

function domainRef(domain: string, value: string): string {
  return createHash("sha256").update(`studenthub:${domain}:v1\0`, "utf8").update(value, "utf8").digest("hex");
}

/** The contract's `personRef` for a platform person record. Never the raw id. */
export function personRecordRef(principalId: string): string {
  return domainRef("person-record-ref", principalId);
}

/** The contract's `principalRef`: the same reference SHU-59 audit rows use. */
export function safeWritePrincipalRef(principalId: string): string {
  return principalAuditRef(principalId);
}

function isInstant(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function tokenRef(tokenId: string): string {
  return domainRef("safe-write-token-ref", tokenId);
}

export interface PostgresSafeWriteStoreOptions {
  readonly connectionString?: string;
  readonly pool?: pg.Pool;
}

interface ReceiptRow {
  readonly request_ref: string;
  readonly actor_principal_ref: string | null;
  readonly after_summary: {
    readonly contractVersion: string;
    readonly personRef: string;
    readonly changeSetDigest: string;
    readonly fields: readonly string[];
    readonly committedAt: string;
  };
}

class Refusal extends Error {
  constructor(readonly reason: Exclude<CommitOutcome, { ok: true }>["reason"]) {
    super(reason);
  }
}

export class PostgresSafeWriteStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;

  constructor(options: PostgresSafeWriteStoreOptions = {}) {
    this.#ownsPool = options.pool === undefined;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  /**
   * The port for one signed-in principal. The session decides who is asking;
   * every reference the contract hands back is compared against this binding,
   * so the port cannot read or write any other person's record.
   */
  forPrincipal(principalId: string): SafeWriteStore {
    if (typeof principalId !== "string" || principalId.length === 0) throw new TypeError("principal id required");
    const ownPrincipalRef = safeWritePrincipalRef(principalId);
    const ownPersonRef = personRecordRef(principalId);
    return {
      ownedRecord: async (principalRef) => {
        if (principalRef !== ownPrincipalRef) return null;
        return await this.#mayWrite(this.#pool, principalId) ? ownPersonRef : null;
      },
      readField: async (personRef, field) => {
        if (personRef !== ownPersonRef || field !== LANGUAGE_FIELD) return null;
        return this.#readLanguage(this.#pool, principalId);
      },
      commit: async (input) => {
        if (input.principalRef !== ownPrincipalRef || input.personRef !== ownPersonRef) {
          return { ok: false, reason: "not_own_record" };
        }
        return this.#commit(principalId, input);
      },
    };
  }

  /** The caller's own receipt, or null. A reference owned by someone else is indistinguishable from none. */
  async readReceipt(principalId: string, receiptRef: string): Promise<Receipt | null> {
    if (!REFERENCE.test(receiptRef)) return null;
    const { rows } = await this.#pool.query<ReceiptRow>(
      `SELECT request_ref, actor_principal_ref, after_summary
         FROM authorization_mutation_audit
        WHERE operation = $1 AND request_ref = $2 AND target_principal_ref = $3`,
      [SAFE_WRITE_OPERATION, receiptRef, safeWritePrincipalRef(principalId)],
    );
    const row = rows[0];
    if (!row) return null;
    const receipt = {
      contractVersion: row.after_summary?.contractVersion,
      receiptRef: row.request_ref,
      personRef: row.after_summary?.personRef,
      principalRef: row.actor_principal_ref,
      changeSetDigest: row.after_summary?.changeSetDigest,
      fields: row.after_summary?.fields,
      committedAt: row.after_summary?.committedAt,
    };
    // Fail closed: a row the database should have refused is never served as a
    // receipt. Every position must hold exactly the kind of value it is for.
    if (receipt.receiptRef !== receiptRef
      || receipt.principalRef !== safeWritePrincipalRef(principalId)
      || receipt.personRef !== personRecordRef(principalId)
      || typeof receipt.contractVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(receipt.contractVersion)
      || typeof receipt.changeSetDigest !== "string" || !REFERENCE.test(receipt.changeSetDigest)
      || !Array.isArray(receipt.fields) || receipt.fields.length !== 1 || receipt.fields[0] !== LANGUAGE_FIELD
      || typeof receipt.committedAt !== "string" || !isInstant(receipt.committedAt)) {
      throw new Error("malformed safe-write receipt");
    }
    return Object.freeze({ ...receipt, fields: Object.freeze([LANGUAGE_FIELD]) }) as Receipt;
  }

  /**
   * Write authority is re-derived from server-side grants on every call: the
   * principal must still exist and still hold at least one grant. A person
   * whose every grant has been revoked can no longer change their record.
   */
  async #mayWrite(client: pg.Pool | pg.PoolClient, principalId: string): Promise<boolean> {
    const { rows } = await client.query(
      `SELECT 1 FROM principals p
        WHERE p.id = $1 AND EXISTS (SELECT 1 FROM grants g WHERE g.principal_id = p.id)`,
      [principalId],
    );
    return rows.length === 1;
  }

  async #readLanguage(client: pg.Pool | pg.PoolClient, principalId: string): Promise<string | null> {
    const { rows } = await client.query<{ language: string }>(
      "SELECT language FROM person_preferences WHERE principal_id = $1",
      [principalId],
    );
    return rows[0]?.language ?? null;
  }

  async #commit(principalId: string, input: CommitInput): Promise<CommitOutcome> {
    const { receipt } = input;
    if (input.field !== LANGUAGE_FIELD || receipt.personRef !== input.personRef
      || receipt.principalRef !== input.principalRef || receipt.changeSetDigest !== input.changeSetDigest
      || receipt.fields.length !== 1 || receipt.fields[0] !== LANGUAGE_FIELD) {
      // The contract builds these together; a mismatch is a programming error,
      // and throwing aborts before anything is written.
      throw new TypeError("inconsistent safe-write commit");
    }
    const spentRef = tokenRef(input.tokenId);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      // The lock PostgresAuthzStore takes for every grant mutation of this
      // principal. Holding it makes the ownership check below and the write
      // one serialized step with respect to revocation.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 5959))", [principalId]);
      const used = await client.query(
        `SELECT 1 FROM authorization_mutation_audit
          WHERE operation = $1 AND after_summary ->> 'tokenRef' = $2`,
        [SAFE_WRITE_OPERATION, spentRef],
      );
      if (used.rows.length > 0) throw new Refusal("token_already_used");
      if (!await this.#mayWrite(client, principalId)) throw new Refusal("not_own_record");

      // Compare-and-write: the change lands only on the value the preview showed.
      const written = input.expectedBefore === null
        ? await client.query(
          `INSERT INTO person_preferences (principal_id, language) VALUES ($1, $2)
           ON CONFLICT (principal_id) DO NOTHING RETURNING 1`,
          [principalId, input.value],
        )
        : await client.query(
          `UPDATE person_preferences SET language = $2, updated_at = clock_timestamp()
            WHERE principal_id = $1 AND language = $3 RETURNING 1`,
          [principalId, input.value, input.expectedBefore],
        );
      if (written.rows.length !== 1) throw new Refusal("state_changed");

      await client.query(
        `INSERT INTO authorization_mutation_audit
           (request_ref, actor_principal_ref, operation, target_principal_ref,
            target_org_refs, before_summary, after_summary)
         VALUES ($1, $2, $3, $2, '{}'::text[], $4::jsonb, $5::jsonb)`,
        [
          receipt.receiptRef,
          receipt.principalRef,
          SAFE_WRITE_OPERATION,
          JSON.stringify({ valuePresent: input.expectedBefore !== null }),
          JSON.stringify({
            contractVersion: receipt.contractVersion,
            personRef: receipt.personRef,
            changeSetDigest: receipt.changeSetDigest,
            fields: [LANGUAGE_FIELD],
            committedAt: receipt.committedAt,
            tokenRef: spentRef,
          }),
        ],
      );
      await client.query("COMMIT");
      return { ok: true };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original outcome */ }
      if (error instanceof Refusal) return { ok: false, reason: error.reason };
      // The unique token index is the backstop for single use.
      if ((error as { code?: unknown; constraint?: unknown })?.code === "23505"
        && (error as { constraint?: unknown }).constraint === "authorization_mutation_audit_safe_write_token") {
        return { ok: false, reason: "token_already_used" };
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
