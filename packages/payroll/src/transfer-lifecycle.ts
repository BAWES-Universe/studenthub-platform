/** F-3 domain only. No provider, money movement, HTTP permission matrix or wallet.
 * Legacy state numbers are mapped explicitly. A store must serialize ALL writes to a
 * transfer (including F-1 lines and F-5 paid flags) with lockTransfer, and commit
 * state, children, invoice port calls and history in the SAME transaction.
 */
export const TRANSFER_STATUS = {
  draft: "draft", locked: "locked", paymentSent: "payment_sent",
  distributing: "distributing", complete: "complete", cancelled: "cancelled",
} as const;
export type TransferStatus = (typeof TRANSFER_STATUS)[keyof typeof TRANSFER_STATUS];
export type TransferAction = "lock" | "cancel" | "payment_sent" | "payment_received"
  | "admin_revert" | "admin_unlock" | "complete" | "reopen_after_unpaid" | "delete";
export const LEGACY_TRANSFER_STATUS: Readonly<Record<TransferStatus, number>> = {
  draft: 10, locked: 5, payment_sent: 1, distributing: 3, complete: 4, cancelled: 0,
};
export interface LifecycleTransfer {
  readonly id: string;
  readonly companyId: string;
  readonly status: TransferStatus;
  readonly deleted: boolean;
}
export interface LifecycleActor { readonly principalId: string; readonly actingAs: boolean }
export interface LifecycleChange {
  readonly transferId: string;
  readonly actorId: string;
  readonly action: TransferAction;
  readonly from: TransferStatus;
  readonly to: TransferStatus;
  readonly deleted: boolean;
  readonly occurredAt: string;
}
export type LifecycleRefusal = "invalid_input" | "not_found" | "forbidden"
  | "invalid_transition" | "unassigned_people" | "unpaid_lines" | "no_unpaid_lines";
export type LifecycleResult =
  | { readonly kind: "changed"; readonly change: LifecycleChange }
  | { readonly kind: "refused"; readonly code: LifecycleRefusal; readonly personIds?: readonly string[] };

/** Deliberately no default implementation: integration must supply real checked
 * authorization and transactional invoice/cascade adapters, never a no-op.
 * admin_* require administrator authority; other roles stay with Access's
 * verified permission mapping. Finance writes must reject act-as sessions.
 */
export interface TransferLifecycleTransaction {
  lockTransfer(id: string): Promise<LifecycleTransfer | undefined>;
  authorize(actor: LifecycleActor, transfer: LifecycleTransfer, action: TransferAction): Promise<boolean>;
  /** Current membership, matching legacy lock, not only historical assignment. */
  unassignedPersonIds(transferId: string): Promise<readonly string[]>;
  hasUnpaidLines(transferId: string): Promise<boolean>;
  /** Ensure stable children and invoice identities; called only on draft→locked.
   * Must reuse on relock, not duplicate. Billing owns invoice calculation/issue.
   * PG adapter calls billing issueForLockedTransfer with this same client.
   */
  ensureChildrenAndInvoices(transferId: string): Promise<void>;
  /** Billing port marks parent and child invoices paid in this transaction. */
  markInvoicesPaid(transferId: string): Promise<void>;
  /** Transfer, children, lines and invoices: SOFT delete only, in this tx. */
  softDeleteGroup(transferId: string): Promise<void>;
  /** paymentReceivedOn is set only on payment_received; other actions preserve it. */
  setState(transferId: string, status: TransferStatus, paymentReceivedOn?: string): Promise<void>;
  appendHistory(change: LifecycleChange): Promise<void>;
}
export interface TransferLifecycleStore {
  /** Roll back on any exception. Never swallow adapter/audit errors. */
  transaction<T>(work: (tx: TransferLifecycleTransaction) => Promise<T>): Promise<T>;
}

const targets: Record<TransferAction, Partial<Record<TransferStatus, TransferStatus>>> = {
  lock: { draft: "locked" }, cancel: { draft: "cancelled" }, payment_sent: { locked: "payment_sent" },
  payment_received: { locked: "distributing", payment_sent: "distributing" }, admin_revert: { payment_sent: "locked" },
  admin_unlock: { locked: "draft", payment_sent: "draft" }, complete: { distributing: "complete" },
  reopen_after_unpaid: { complete: "distributing" }, delete: { cancelled: "cancelled", draft: "draft", locked: "locked" },
};

/** Pure exhaustive transition selection. Repeats refuse, not a second event. */
export function transferTransition(status: TransferStatus, action: TransferAction): TransferStatus | undefined {
  if (!Object.hasOwn(targets, action)) return undefined;
  return Object.hasOwn(targets[action], status) ? targets[action][status] : undefined;
}

/** Date supplied by trusted clock; receipt date is the Kuwait calendar day. */
export function paymentReceivedDate(instant: Date): string {
  return new Date(instant.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export class TransferLifecycleService {
  constructor(private readonly store: TransferLifecycleStore, private readonly now: () => Date) {}

  async transition(actor: LifecycleActor, transferId: string, action: TransferAction): Promise<LifecycleResult> {
    if (!actor?.principalId?.trim() || !transferId?.trim() || !Object.hasOwn(targets, action)) {
      return { kind: "refused", code: "invalid_input" };
    }
    const identity = Object.freeze({ principalId: actor.principalId, actingAs: actor.actingAs });
    if (identity.actingAs !== false) return { kind: "refused", code: "forbidden" };
    return this.store.transaction((tx) => this.transitionInTransaction(tx, identity, transferId, action));
  }

  /** F-5 can reuse its existing transaction after updating a paid flag. */
  async transitionInTransaction(tx: TransferLifecycleTransaction, actor: LifecycleActor, transferId: string, action: TransferAction): Promise<LifecycleResult> {
      if (!actor?.principalId?.trim() || !transferId?.trim() || !Object.hasOwn(targets, action)) {
        return { kind: "refused", code: "invalid_input" };
      }
      const identity = Object.freeze({ principalId: actor.principalId, actingAs: actor.actingAs });
      if (identity.actingAs !== false) return { kind: "refused", code: "forbidden" };
      const transfer = await tx.lockTransfer(transferId);
      if (!transfer || transfer.deleted) return { kind: "refused", code: "not_found" };
      // Permission is checked before disclosing transition or person details.
      if (!await tx.authorize(identity, transfer, action)) return { kind: "refused", code: "not_found" };
      const to = transferTransition(transfer.status, action);
      if (to === undefined) return { kind: "refused", code: "invalid_transition" };
      if (action === "lock") {
        const personIds = [...new Set(await tx.unassignedPersonIds(transfer.id))].sort();
        if (personIds.length) return { kind: "refused", code: "unassigned_people", personIds };
      }
      if (action === "complete" && await tx.hasUnpaidLines(transfer.id)) {
        return { kind: "refused", code: "unpaid_lines" };
      }
      // Internal F-5 hook AFTER an actual unpaid mutation, under the same lock.
      if (action === "reopen_after_unpaid" && !await tx.hasUnpaidLines(transfer.id)) {
        return { kind: "refused", code: "no_unpaid_lines" };
      }
      const instant = this.now();
      const change: LifecycleChange = {
        transferId: transfer.id, actorId: identity.principalId, action,
        from: transfer.status, to, deleted: action === "delete", occurredAt: instant.toISOString(),
      };
      if (action === "lock") await tx.ensureChildrenAndInvoices(transfer.id);
      if (action === "payment_received") await tx.markInvoicesPaid(transfer.id);
      // Record the exact source state/version in the same transaction before updating.
      await tx.appendHistory(change);
      if (action === "delete") await tx.softDeleteGroup(transfer.id);
      else await tx.setState(transfer.id, to, action === "payment_received" ? paymentReceivedDate(instant) : undefined);
      return { kind: "changed", change };
  }
}
