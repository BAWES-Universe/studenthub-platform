import pg from "pg";
import { databaseUrl } from "../connection.js";

/** The line ids the person's pay history accepts; a line outside this form gets no feed item. */
const LINE_ID = "^[A-Za-z0-9._:-]{1,128}$";

/**
 * A transfer whose payment was received, in the feed of each person on it (legacy candidate
 * notification type 5, "New transfer initiated", written by Transfer::sendNewTransferNotification
 * for each candidate line when staff marked the payment received). The pay lane records that step as
 * an append-only `pay_transfer_lifecycle_history` row with action 'payment_received'. This store
 * dispatches each such row once, from the email delivery job: a `pay.transfer_initiated` feed item
 * for each line's person, dated when the payment was received and rendered at read time.
 *
 * The mark that a step is done is a row in `comms_dispatched_transfer_receipts`, inserted in the same
 * transaction as the feed items; of two workers that pick the same step, only the one whose mark wins
 * writes the items. Read-only use of the pay lane's tables.
 */
export class PostgresTransferInitiatedFeedStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /** Dispatches up to `limit` undispatched payment-received steps, oldest first; returns how many feed items it wrote. */
  async dispatch(limit: number, at: Date): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("limit must be 1 to 1000");
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      const steps = (await c.query<{ id: string; transfer_id: string; occurred_at: Date }>(
        `SELECT h.id::text id, h.transfer_id, h.occurred_at FROM pay_transfer_lifecycle_history h
          WHERE h.action = 'payment_received'
            AND NOT EXISTS (SELECT 1 FROM comms_dispatched_transfer_receipts d WHERE d.history_id = h.id)
          ORDER BY h.id LIMIT $1`, [limit])).rows;
      let written = 0;
      for (const s of steps) {
        const marked = await c.query("INSERT INTO comms_dispatched_transfer_receipts(history_id, dispatched_at) VALUES($1::bigint, $2) ON CONFLICT DO NOTHING", [s.id, at]);
        if (marked.rowCount !== 1) continue;
        const items = await c.query(
          `INSERT INTO notifications(recipient_principal_id, kind, subject_reference, parameters, dedupe_key, created_at)
           SELECT l.person_id, 'pay.transfer_initiated', 'pay_line:' || l.id, '{}'::jsonb, 'pay_line:' || l.id, $2
             FROM pay_transfer_lines l WHERE l.transfer_id = $1 AND l.id ~ '${LINE_ID}'
             ORDER BY l.id
           ON CONFLICT (recipient_principal_id, dedupe_key) DO NOTHING`, [s.transfer_id, s.occurred_at]);
        written += items.rowCount ?? 0;
      }
      await c.query("COMMIT");
      return written;
    } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { c.release(); }
  }
}
