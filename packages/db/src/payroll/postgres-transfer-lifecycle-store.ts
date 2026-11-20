import type pg from "pg";

// Structural boundary DTOs: db does not import unbuilt payroll workspace source.
export type PayLifecycleStatus = "draft" | "locked" | "payment_sent" | "distributing" | "complete" | "cancelled";
export type PayLifecycleAction = "lock" | "cancel" | "payment_sent" | "payment_received" | "admin_revert" | "admin_unlock" | "complete" | "reopen_after_unpaid" | "delete";
export interface PayLifecycleActor { readonly principalId: string; readonly actingAs: boolean }
export interface PayLifecycleTransfer { readonly id: string; readonly companyId: string; readonly status: PayLifecycleStatus; readonly deleted: boolean }
export interface PayLifecycleHistory {
  readonly transferId: string; readonly actorId: string; readonly action: PayLifecycleAction;
  readonly from: PayLifecycleStatus; readonly to: PayLifecycleStatus; readonly deleted: boolean; readonly occurredAt: string;
}
/** Caller supplies verified, company-scoped permissions and current membership.
 * Both read the transaction client. There are no permissive production defaults.
 */
export interface PayLifecyclePolicy {
  authorize(client: pg.PoolClient, actor: PayLifecycleActor, transfer: PayLifecycleTransfer, action: PayLifecycleAction): Promise<boolean>;
  unassignedPersonIds(client: pg.PoolClient, transferId: string): Promise<readonly string[]>;
}
/** Billing owns actual child/invoice issuance, paid state and deletion cascades.
 * All methods must use this SAME client, never a separate connection/commit.
 */
export interface PayLifecycleEffects {
  ensureChildrenAndInvoices(client: pg.PoolClient, transferId: string): Promise<void>;
  markInvoicesPaid(client: pg.PoolClient, transferId: string): Promise<void>;
  softDeleteGroup(client: pg.PoolClient, transferId: string): Promise<void>;
}
const unavailable = async (): Promise<never> => { throw new Error("pay_lifecycle_billing_unavailable"); };
export const UNAVAILABLE_PAY_LIFECYCLE_EFFECTS: PayLifecycleEffects = Object.freeze({
  ensureChildrenAndInvoices: unavailable, markInvoicesPaid: unavailable, softDeleteGroup: unavailable,
});

export class PostgresTransferLifecycleTransaction {
  private readonly locked = new Set<string>();
  constructor(private readonly client: pg.PoolClient, private readonly policy: PayLifecyclePolicy,
    private readonly effects: PayLifecycleEffects) {}
  private requireLock(id: string): void {
    if (!this.locked.has(id)) throw new Error("pay_lifecycle_transfer_not_locked");
  }
  async lockTransfer(id: string): Promise<PayLifecycleTransfer | undefined> {
    const result = await this.client.query("SELECT id,company_id,status,deleted FROM pay_transfers WHERE id=$1 FOR UPDATE", [id]);
    const row = result.rows[0];
    if (!row) return undefined;
    this.locked.add(id);
    return { id: row.id, companyId: row.company_id, status: row.status, deleted: row.deleted };
  }
  async authorize(actor: PayLifecycleActor, transfer: PayLifecycleTransfer, action: PayLifecycleAction): Promise<boolean> {
    this.requireLock(transfer.id);
    return actor.actingAs === false && await this.policy.authorize(this.client, actor, transfer, action);
  }
  async unassignedPersonIds(id: string): Promise<readonly string[]> {
    this.requireLock(id); return this.policy.unassignedPersonIds(this.client, id);
  }
  async hasUnpaidLines(id: string): Promise<boolean> {
    this.requireLock(id);
    return (await this.client.query("SELECT EXISTS(SELECT 1 FROM pay_transfer_lines WHERE transfer_id=$1 AND NOT paid) AS unpaid", [id])).rows[0].unpaid;
  }
  async ensureChildrenAndInvoices(id: string): Promise<void> {
    this.requireLock(id); await this.effects.ensureChildrenAndInvoices(this.client, id);
  }
  async markInvoicesPaid(id: string): Promise<void> {
    this.requireLock(id); await this.effects.markInvoicesPaid(this.client, id);
  }
  async softDeleteGroup(id: string): Promise<void> {
    this.requireLock(id);
    // Do not advertise successful deletion until the full billing cascade exists.
    await this.effects.softDeleteGroup(this.client, id);
    await this.client.query("UPDATE pay_transfers SET deleted=true,version=version+1 WHERE id=$1", [id]);
  }
  async setState(id: string, status: PayLifecycleStatus, paymentReceivedOn?: string): Promise<void> {
    this.requireLock(id);
    await this.client.query("UPDATE pay_transfers SET status=$2,version=version+1,payment_received_on=COALESCE($3::date,payment_received_on) WHERE id=$1", [id, status, paymentReceivedOn ?? null]);
  }
  async appendHistory(change: PayLifecycleHistory): Promise<void> {
    this.requireLock(change.transferId);
    const result = await this.client.query(
      "INSERT INTO pay_transfer_lifecycle_history(transfer_id,actor_id,action,from_status,to_status,deleted,occurred_at,source_version) SELECT id,$2,$3,$4,$5,$6,$7,version FROM pay_transfers WHERE id=$1 AND status=$4 AND NOT deleted",
      [change.transferId, change.actorId, change.action, change.from, change.to, change.deleted, change.occurredAt]);
    if (result.rowCount !== 1) throw new Error("pay_lifecycle_history_subject_changed");
  }
}

export class PostgresTransferLifecycleStore {
  constructor(private readonly pool: pg.Pool, private readonly policy: PayLifecyclePolicy,
    private readonly effects: PayLifecycleEffects = UNAVAILABLE_PAY_LIFECYCLE_EFFECTS) {}
  async transaction<T>(work: (tx: PostgresTransferLifecycleTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let broken = false;
    try {
      await client.query("BEGIN");
      const result = await work(new PostgresTransferLifecycleTransaction(client, this.policy, this.effects));
      await client.query("COMMIT"); return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }
}
