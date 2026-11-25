import pg from "pg";
import { databaseUrl } from "../connection.js";

/**
 * A new placement in the placed person's feed (legacy candidate notification type 1, written by
 * CandidateWorkHistory::afterSave). The work lane writes an `assignment.created` work event in the
 * same transaction as each placement and never notifies anyone itself; this store dispatches each
 * such event once, from the email delivery job: a `work.assigned` feed item for the person, dated
 * when the placement was made and rendered at read time from the placement as it is then.
 *
 * The mark that an event is done is a row in `comms_dispatched_work_events`, inserted in the same
 * transaction as the feed item. Two workers that pick the same event both try the mark; only the
 * one whose insert wins writes the item. Read-only use of `work_events`.
 */
export class PostgresPlacementFeedStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /** Dispatches up to `limit` undispatched placement events, oldest first; returns how many feed items it wrote. */
  async dispatch(limit: number, at: Date): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("limit must be 1 to 1000");
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      const events = (await c.query<{ id: string; person_principal_id: string; subject_id: string; occurred_at: Date }>(
        `SELECT e.id::text id, e.person_principal_id, e.subject_id::text subject_id, e.occurred_at FROM work_events e
          WHERE e.kind = 'assignment.created' AND NOT EXISTS (SELECT 1 FROM comms_dispatched_work_events d WHERE d.event_id = e.id)
          ORDER BY e.id LIMIT $1`, [limit])).rows;
      let written = 0;
      for (const e of events) {
        const marked = await c.query("INSERT INTO comms_dispatched_work_events(event_id, dispatched_at) VALUES($1::bigint, $2) ON CONFLICT DO NOTHING", [e.id, at]);
        if (marked.rowCount !== 1) continue;
        const reference = `work_assignment:${e.subject_id}`;
        await c.query(`INSERT INTO notifications(recipient_principal_id, kind, subject_reference, parameters, dedupe_key, created_at)
          VALUES($1, 'work.assigned', $2, '{}'::jsonb, $2, $3) ON CONFLICT (recipient_principal_id, dedupe_key) DO NOTHING`,
          [e.person_principal_id, reference, e.occurred_at]);
        written += 1;
      }
      await c.query("COMMIT");
      return written;
    } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { c.release(); }
  }
}
