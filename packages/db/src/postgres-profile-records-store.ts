import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";
import type {
  ProfileRecordAudit, ProfileRecordKind, ProfileRecordStore, ProfileRecordTransaction,
  ReferenceResolver, ReferenceType, StoredProfileRecord,
} from "@studenthub/profile-records";
import { principalAuditRef, requestAuditRef } from "./authorization-audit.js";

interface RecordRow {
  id: string; owner_principal_id: string; kind: ProfileRecordKind; status: "active" | "deleted";
  fields: StoredProfileRecord["fields"]; created_at: Date; updated_at: Date; deleted_at: Date | null;
}

const COLUMNS = "id, owner_principal_id, kind, status, fields, created_at, updated_at, deleted_at";

function fromRow(row: RecordRow): StoredProfileRecord {
  return Object.freeze({
    id: row.id, ownerId: row.owner_principal_id, kind: row.kind, status: row.status,
    fields: Object.freeze(row.fields), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    ...(row.deleted_at ? { deletedAt: row.deleted_at.toISOString() } : {}),
  });
}

/** SHU-144 store. Every query carries the owner predicate; audit rows share the mutation's transaction. */
export class PostgresProfileRecordStore implements ProfileRecordStore {
  readonly #pool: PgPool;
  readonly #ownsPool: boolean;

  constructor(poolOrConfig: PgPool | PoolConfig) {
    this.#pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#ownsPool = !(poolOrConfig instanceof pg.Pool);
  }

  async close(): Promise<void> { if (this.#ownsPool) await this.#pool.end(); }

  async listAll(ownerId: string): Promise<readonly StoredProfileRecord[]> {
    const { rows } = await this.#pool.query<RecordRow>(
      `SELECT ${COLUMNS} FROM candidate_profile_records WHERE owner_principal_id = $1 ORDER BY created_at, id`,
      [ownerId],
    );
    return rows.map(fromRow);
  }

  async transaction<T>(work: (tx: ProfileRecordTransaction) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(transactionFor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function transactionFor(client: PoolClient): ProfileRecordTransaction {
  return {
    async listOwned(ownerId: string, kind: ProfileRecordKind) {
      // An advisory lock serializes concurrent writers on one owner's rows of a kind (limits, duplicate skills).
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`profile-records:${ownerId}:${kind}`]);
      const { rows } = await client.query<RecordRow>(
        `SELECT ${COLUMNS} FROM candidate_profile_records WHERE owner_principal_id = $1 AND kind = $2 ORDER BY created_at, id`,
        [ownerId, kind],
      );
      return rows.map(fromRow);
    },
    async findOwned(ownerId: string, kind: ProfileRecordKind, id: string) {
      const { rows } = await client.query<RecordRow>(
        `SELECT ${COLUMNS} FROM candidate_profile_records WHERE id = $1 AND owner_principal_id = $2 AND kind = $3 FOR UPDATE`,
        [id, ownerId, kind],
      );
      return rows[0] ? fromRow(rows[0]) : undefined;
    },
    async insert(record: StoredProfileRecord) {
      await client.query(
        `INSERT INTO candidate_profile_records (${COLUMNS}) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [record.id, record.ownerId, record.kind, record.status, JSON.stringify(record.fields), record.createdAt, record.updatedAt, record.deletedAt ?? null],
      );
    },
    async replace(record: StoredProfileRecord) {
      const result = await client.query(
        `UPDATE candidate_profile_records SET status = $4, fields = $5::jsonb, updated_at = $6, deleted_at = $7
         WHERE id = $1 AND owner_principal_id = $2 AND kind = $3`,
        [record.id, record.ownerId, record.kind, record.status, JSON.stringify(record.fields), record.updatedAt, record.deletedAt ?? null],
      );
      if (result.rowCount !== 1) throw new Error("profile record not updated");
    },
    async audit(entry: ProfileRecordAudit) {
      const ownerRef = principalAuditRef(entry.ownerId);
      await client.query(
        `INSERT INTO authorization_mutation_audit
           (request_ref, actor_principal_ref, operation, target_principal_ref, target_org_refs, before_summary, after_summary)
         VALUES ($1, $2, $3, $2, '{}'::text[], $4::jsonb, $5::jsonb)`,
        [
          requestAuditRef(`profile_record_${randomUUID()}`), ownerRef, entry.operation,
          JSON.stringify({ kind: entry.kind, activeCount: entry.activeBefore }),
          JSON.stringify({ kind: entry.kind, activeCount: entry.activeAfter }),
        ],
      );
    },
  };
}

/** Reads the SHU-166 catalogue table directly; deleted rows still resolve, with their status. */
export class PostgresReferenceResolver implements ReferenceResolver {
  readonly #pool: PgPool;
  readonly #ownsPool: boolean;

  constructor(poolOrConfig: PgPool | PoolConfig) {
    this.#pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#ownsPool = !(poolOrConfig instanceof pg.Pool);
  }

  async close(): Promise<void> { if (this.#ownsPool) await this.#pool.end(); }

  async resolve(type: ReferenceType, id: string): Promise<{ readonly status: "active" | "deleted" } | undefined> {
    const { rows } = await this.#pool.query<{ status: "active" | "deleted" }>(
      "SELECT status FROM catalogue_items WHERE catalogue_type = $1 AND id = $2::uuid",
      [type, id],
    );
    return rows[0] ? { status: rows[0].status } : undefined;
  }
}
