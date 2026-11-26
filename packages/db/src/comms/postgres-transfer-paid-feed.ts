import pg from "pg";
import { databaseUrl } from "../connection.js";

/**
 * A paid transfer line in the person's feed (legacy candidate notification type 6, which the daily
 * cron wrote for each paid line not yet notified: TransferCandidate::sendTransferPaidNotification). A
 * line is marked paid only when a bank result file confirms it, and the pay lane records one
 * append-only `bank_result_confirmations` row in that transaction. This store dispatches each
 * confirmation once, from the email delivery job: a `pay.transfer_paid` feed item for the line's
 * person, dated when the payment was confirmed and rendered at read time.
 *
 * The mark that a confirmation is done is a row in `comms_dispatched_bank_confirmations`, inserted in
 * the same transaction as the feed item; of two workers that pick the same confirmation, only the one
 * whose mark wins writes the item. Read-only use of the pay lane's tables.
 */
export class PostgresTransferPaidFeedStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /** Dispatches up to `limit` undispatched confirmations, oldest first; returns how many feed items it wrote. */
  async dispatch(limit: number, at: Date): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("limit must be 1 to 1000");
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      const rows = (await c.query<{ id: string; person_id: string; recorded_at: Date }>(
        `SELECT bc.id::text id, l.person_id, bc.recorded_at FROM bank_result_confirmations bc JOIN pay_transfer_lines l ON l.id = bc.line_id
          WHERE NOT EXISTS (SELECT 1 FROM comms_dispatched_bank_confirmations d WHERE d.confirmation_id = bc.id)
          ORDER BY bc.id LIMIT $1`, [limit])).rows;
      let written = 0;
      for (const r of rows) {
        const marked = await c.query("INSERT INTO comms_dispatched_bank_confirmations(confirmation_id, dispatched_at) VALUES($1::bigint, $2) ON CONFLICT DO NOTHING", [r.id, at]);
        if (marked.rowCount !== 1) continue;
        const reference = `bank_confirmation:${r.id}`;
        await c.query(`INSERT INTO notifications(recipient_principal_id, kind, subject_reference, parameters, dedupe_key, created_at)
          VALUES($1, 'pay.transfer_paid', $2, '{}'::jsonb, $2, $3) ON CONFLICT (recipient_principal_id, dedupe_key) DO NOTHING`,
          [r.person_id, reference, r.recorded_at]);
        written += 1;
      }
      await c.query("COMMIT");
      return written;
    } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { c.release(); }
  }
}
