import pg from "pg";
import { databaseUrl } from "../connection.js";

/**
 * Delivers the recruit lane's outbox (migrations 0453 to 0458), which recruit writes in the same
 * transaction as each invitation, interview and application change and never sends itself. Each
 * row is dispatched once, in one transaction with its effects: a feed item `recruit.<event>` for its
 * recipient, dated when the change happened and rendered at read time (so it shows the request as
 * it is then), and, for a sent
 * invitation that is still open, the job invitation email (legacy `Invitation::afterSave`). Rows are
 * claimed with SKIP LOCKED, so several workers never dispatch the same row twice.
 */
const LINE = (text: string) => [...text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")].slice(0, 255).join("").trim();

export class PostgresRecruitDispatchStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /** Dispatches up to `limit` undispatched rows, oldest first; returns how many. */
  async dispatch(limit: number, at: Date): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("limit must be 1 to 1000");
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      const rows = (await c.query<{ id: string; kind: string; recipient_principal_id: string; subject_id: string; position_title: string; company_name: string; open_invitation: boolean; created_at: Date }>(
        `SELECT r.id::text id, r.kind, r.created_at, r.recipient_principal_id, r.subject_id::text subject_id, q.position_title, o.name company_name,
           EXISTS (SELECT 1 FROM recruit_invitations i WHERE i.id = r.subject_id AND i.status IN ('sent','seen')) open_invitation
         FROM recruit_outbox r JOIN recruit_requests q ON q.id = r.request_id JOIN organizations o ON o.id = q.org_id
         WHERE r.dispatched_at IS NULL ORDER BY r.id FOR UPDATE OF r SKIP LOCKED LIMIT $1`, [limit])).rows;
      for (const r of rows) {
        await c.query(`INSERT INTO notifications(recipient_principal_id, kind, subject_reference, parameters, dedupe_key, created_at)
          VALUES($1, $2, $3, '{}'::jsonb, $3, $4) ON CONFLICT (recipient_principal_id, dedupe_key) DO NOTHING`,
          [r.recipient_principal_id, `recruit.${r.kind}`, `recruit_outbox:${r.id}`, r.created_at]);
        const position = LINE(r.position_title), company = LINE(r.company_name);
        // A withdrawn invitation is not emailed, even if the withdrawal came before this run.
        if (r.kind === "invitation.sent" && r.open_invitation && position && company)
          await c.query(`INSERT INTO email_outbox(class, recipient_principal_id, template_parameters, idempotency_key)
            VALUES('recruit.invitation', $1, $2::jsonb, $3) ON CONFLICT (idempotency_key) DO NOTHING`,
            [r.recipient_principal_id, JSON.stringify({ position, company }), `recruit.invitation:${r.subject_id}`]);
        await c.query("UPDATE recruit_outbox SET dispatched_at = $2 WHERE id = $1::bigint", [r.id, at]);
      }
      await c.query("COMMIT");
      return rows.length;
    } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { c.release(); }
  }
}
