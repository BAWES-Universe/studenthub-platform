import pg from "pg";
import { CivilIdError } from "./format.js";
import { civilIdRef, type CivilIdRow, type CivilIdStore, type CivilIdTransaction, type OcrJob } from "./verification.js";

const ROW_FIELDS = `candidate_ref AS "candidateRef", civil_id_number AS "civilIdNumber",
  country_code AS "countryCode", expiry_date::text AS "expiryDate", need_verification AS "needVerification",
  source, candidate_deleted AS "candidateDeleted", revision,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`;

/** Internal port; configure a dedicated pool without query/parameter logging.
 * Borrowed pool remains caller-owned. No schema changes or external I/O at construction.
 */
export class PostgresCivilIdStore implements CivilIdStore {
  constructor(private readonly pool: pg.Pool) {}

  async transaction<T>(keys: { candidateRef?: string; jobId?: string }, work: (tx: CivilIdTransaction) => Promise<T>): Promise<T> {
    let client: pg.PoolClient | undefined;
    let broken = false;
    try {
      client = await this.pool.connect();
      const db = client;
      await db.query("BEGIN");
      // Fixed lock order: job before candidate. Hash collisions only serialize work.
      for (const key of [keys.jobId === undefined ? undefined : `job:${keys.jobId}`,
        keys.candidateRef === undefined ? undefined : `candidate:${keys.candidateRef}`]) {
        if (key !== undefined) await db.query("SELECT pg_advisory_xact_lock($1::bigint)",
          [BigInt.asIntN(64, BigInt(`0x${civilIdRef(key).slice(0, 16)}`)).toString()]);
      }
      const tx: CivilIdTransaction = {
        read: async (candidateRef) => (await db.query<CivilIdRow>(
          `SELECT ${ROW_FIELDS} FROM candidate_civil_id WHERE candidate_ref = $1 FOR UPDATE`, [candidateRef])).rows[0],
        write: async (row) => {
          // Recover uniqueness failure without losing the terminal failed-job record.
          await db.query("SAVEPOINT civil_id_write");
          try {
            await db.query(`INSERT INTO candidate_civil_id
              (candidate_ref, civil_id_number, country_code, expiry_date, need_verification, source,
               candidate_deleted, revision, created_at, updated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
              ON CONFLICT (candidate_ref) DO UPDATE SET civil_id_number = EXCLUDED.civil_id_number,
                country_code = EXCLUDED.country_code, expiry_date = EXCLUDED.expiry_date,
                need_verification = EXCLUDED.need_verification, source = EXCLUDED.source,
                revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at`,
            [row.candidateRef, row.civilIdNumber, row.countryCode, row.expiryDate, row.needVerification,
              row.source, row.candidateDeleted, row.revision, row.createdAt, row.updatedAt]);
            await db.query("RELEASE SAVEPOINT civil_id_write");
          } catch (error) {
            await db.query("ROLLBACK TO SAVEPOINT civil_id_write");
            await db.query("RELEASE SAVEPOINT civil_id_write");
            if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
              throw new CivilIdError("civil_id_duplicate");
            }
            throw new CivilIdError("civil_id_unavailable");
          }
        },
        readJob: async (jobId) => (await db.query<OcrJob>(`SELECT job_id AS "jobId", candidate_ref AS "candidateRef",
          status, code, expired, time_zone AS "timeZone",
          to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt"
          FROM civil_id_ocr_job WHERE job_id = $1`, [jobId])).rows[0],
        writeJob: async (job) => {
          await db.query(`INSERT INTO civil_id_ocr_job
            (job_id, candidate_ref, status, code, expired, time_zone, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [job.jobId, job.candidateRef, job.status, job.code, job.expired, job.timeZone, job.occurredAt]);
        },
        audit: async (event) => {
          await db.query(`INSERT INTO civil_id_verification_audit
            (actor_ref, candidate_ref_hash, job_ref, operation, outcome, code, occurred_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [event.actorRef, event.candidateRefHash, event.jobRef, event.operation, event.outcome, event.code, event.occurredAt]);
        },
        listReview: async () => (await db.query<CivilIdRow>(`SELECT ${ROW_FIELDS}
          FROM candidate_civil_id WHERE need_verification AND NOT candidate_deleted ORDER BY candidate_ref`)).rows,
      };
      const result = await work(tx);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch { broken = true; }
      }
      if (error instanceof CivilIdError) throw new CivilIdError(error.code);
      throw new CivilIdError("civil_id_unavailable");
    } finally {
      client?.release(broken);
    }
  }
}
