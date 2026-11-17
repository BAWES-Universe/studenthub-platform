import pg from "pg";
import { databaseUrl } from "../connection.js";

export type StaffMessageKindRow = "profile_photo_request" | "civil_id_request" | "message";
export interface StaffMessageDraftRow {
  readonly recipientPrincipalId: string;
  readonly senderPrincipalId: string;
  readonly kind: StaffMessageKindRow;
  readonly body: string | null;
  readonly sendKey: string;
}
export type StaffMessageSendRow =
  | { readonly status: "sent" | "already_sent"; readonly id: string }
  | { readonly status: "send_key_conflict" | "recipient_not_found" };

/**
 * Staff messages (legacy types 12 to 14). The message row and the recipient's feed row are
 * written in one transaction. A repeat send key returns the first message unchanged; the
 * same key for a different recipient, kind or body is refused, never overwritten.
 */
export class PostgresStaffMessagesStore {
  #pool: pg.Pool | undefined;
  readonly #providedPool: pg.Pool | undefined;
  readonly #connectionString: string;
  constructor(options: { readonly pool?: pg.Pool; readonly connectionString?: string } = {}) {
    this.#providedPool = options.pool;
    this.#pool = options.pool;
    this.#connectionString = options.connectionString ?? databaseUrl();
  }
  #database(): pg.Pool { return this.#pool ??= new pg.Pool({ connectionString: this.#connectionString }); }
  async close(): Promise<void> { if (this.#pool && !this.#providedPool) await this.#pool.end(); }

  async send(draft: StaffMessageDraftRow): Promise<StaffMessageSendRow> {
    const client = await this.#database().connect();
    try {
      await client.query("BEGIN");
      const recipient = await client.query("SELECT 1 FROM principals WHERE id=$1", [draft.recipientPrincipalId]);
      if (recipient.rowCount === 0) { await client.query("ROLLBACK"); return { status: "recipient_not_found" }; }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO staff_messages(recipient_principal_id,sender_principal_id,kind,body,send_key)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(send_key) DO NOTHING RETURNING id::text id`,
        [draft.recipientPrincipalId, draft.senderPrincipalId, draft.kind, draft.body, draft.sendKey]);
      const created = inserted.rows[0];
      if (!created) {
        const existing = await client.query<{ id: string; recipient_principal_id: string; kind: string; body: string | null }>(
          "SELECT id::text id,recipient_principal_id,kind,body FROM staff_messages WHERE send_key=$1", [draft.sendKey]);
        await client.query("COMMIT");
        const row = existing.rows[0];
        if (row && row.recipient_principal_id === draft.recipientPrincipalId && row.kind === draft.kind && row.body === draft.body) {
          return { status: "already_sent", id: row.id };
        }
        return { status: "send_key_conflict" };
      }
      await client.query(
        `INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key)
         VALUES($1,'staff.message',$2,'{}'::jsonb,$2) ON CONFLICT(recipient_principal_id,dedupe_key) DO NOTHING`,
        [draft.recipientPrincipalId, `staff_message:${created.id}`]);
      await client.query("COMMIT");
      return { status: "sent", id: created.id };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
