import { createHash, randomUUID } from 'node:crypto';
import { resolveActiveContext, type AuthzStore, type RequestIdentity, type ActiveContext } from '@studenthub/contracts';
import { createIdempotency, type AtomicMutationInput, type IdempotencyClock, type RefusalReason } from '../../idempotency-contract/src/index.js';
import type { OrgRegistry, OpenLinesPort } from './membership.js';

/** Provisional policy: edit this single value when the product decision changes. */
export const BILLING_ACCOUNT_POLICY = Object.freeze({
  admin: Object.freeze({ role: 'admin', requireParentSubtree: false }),
  owner: Object.freeze({ role: 'org-owner', requireParentSubtree: true }),
});
export interface BillingAccount { readonly id: string; readonly parentOrgId: string; readonly currencyCode: string; readonly billTo: string }
export type BillingAccountErrorCode = 'denied' | 'invalid_input' | 'not_found' | 'account_exists' | 'member_not_eligible' | 'member_has_open_lines' | 'member_account_exists' | 'unavailable' | RefusalReason;
export class BillingAccountError extends Error {
  constructor(readonly status: number, readonly code: BillingAccountErrorCode, readonly orgId?: string) { super(orgId === undefined ? code : `${code}: ${orgId}`); }
}
export interface BillingCaller { /** Already verified by the authentication boundary. */ readonly identity?: RequestIdentity; readonly role: string }
export interface BillingAudit { readonly actorRef: string; readonly operation: 'create' | 'attach' | 'detach'; readonly accountId: string; readonly orgIds: readonly string[]; readonly occurredAt: Date }
export interface BillingTransaction {
  readonly orgs: OrgRegistry;
  now(): Promise<Date>;
  lockIdempotency(input: AtomicMutationInput): Promise<void>;
  findReceipt(input: AtomicMutationInput): Promise<{ fingerprint: string; account: BillingAccount } | undefined>;
  getAccount(id: string): Promise<BillingAccount | undefined>;
  insertAccount(account: BillingAccount, receipt: AtomicMutationInput): Promise<void>;
  listMembers(accountId: string): Promise<string[]>;
  attach(account: BillingAccount, orgIds: readonly string[]): Promise<void>;
  detach(accountId: string, orgId: string): Promise<void>;
  audit(event: BillingAudit): Promise<void>;
}
export interface BillingAccountStore { transaction<T>(work: (tx: BillingTransaction) => Promise<T>): Promise<T> }
export interface BillingOptions { store: BillingAccountStore; authz: AuthzStore; openLines: OpenLinesPort; clock?: IdempotencyClock }
export const actorReference = (id: string): string => createHash('sha256').update(id).digest('hex');
export async function authorizeBilling(caller: BillingCaller, parentOrgId: string, authz: AuthzStore): Promise<ActiveContext> {
  if (!caller.identity) throw new BillingAccountError(403, 'denied');
  const result = await resolveActiveContext(caller.identity, { orgId: parentOrgId, role: caller.role }, authz);
  if (result.kind !== 'authorized') throw new BillingAccountError(403, 'denied');
  const context = result.context;
  const rule = Object.values(BILLING_ACCOUNT_POLICY).find(rule => rule.role === context.role);
  if (!rule || (rule.requireParentSubtree && !(context.scope === 'subtree' && context.grantedByOrgId === parentOrgId))) {
    throw new BillingAccountError(403, 'denied');
  }
  return context;
}
export async function requireCoverage(caller: BillingCaller, orgId: string, authz: AuthzStore): Promise<void> {
  if (!caller.identity) throw new BillingAccountError(403, 'denied');
  const result = await resolveActiveContext(caller.identity, { orgId, role: caller.role }, authz);
  if (result.kind !== 'authorized') throw new BillingAccountError(422, 'member_not_eligible', orgId);
}
export function validText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024 && !value.includes('\0'); }
export class BillingAccounts {
  constructor(readonly options: BillingOptions) {}
  async create(caller: BillingCaller, input: Omit<BillingAccount, 'id'>, key?: string): Promise<BillingAccount> {
    const context = await authorizeBilling(caller, input.parentOrgId, this.options.authz);
    if (!validText(input.parentOrgId) || !validText(input.billTo) || !/^[A-Z]{3}$/.test(input.currencyCode)) throw new BillingAccountError(400, 'invalid_input');
    const payload = { parentOrgId: input.parentOrgId, currencyCode: input.currencyCode, billTo: input.billTo };
    let operationError: unknown;
    let transaction: BillingTransaction | undefined;
    let claim: AtomicMutationInput | undefined;
    const executor = createIdempotency({ clock: this.options.clock, store: {
      // Receipts live with immutable account rows. Retaining them does not allow expired replay.
      cleanupExpired: async () => 0,
      executeAtomic: async (receipt, execute) => {
        try {
          return await this.options.store.transaction(async tx => {
            await tx.lockIdempotency(receipt);
            if ((await tx.now()).getTime() >= receipt.expiresAt.getTime()) return { kind: 'expired' };
            const fresh = await authorizeBilling(caller, input.parentOrgId, this.options.authz);
            if (fresh.principalId !== context.principalId) throw new BillingAccountError(403, 'denied');
            const old = await tx.findReceipt(receipt);
            if (old) return old.fingerprint !== receipt.fingerprint ? { kind: 'conflict' } : { kind: 'replayed', response: { status: 201, body: { ...old.account } } };
            transaction = tx;
            claim = receipt;
            const response = await execute({ insert: () => { throw new Error('unsupported collection'); }, enqueue: () => { throw new Error('unsupported outbox'); } });
            return { kind: 'executed', response };
          });
        } catch (error) { operationError = error; throw error; }
      },
    }});
    const result = await executor.execute({ key, principalRef: actorReference(context.principalId), method: 'POST', route: '/billing/accounts', payload }, async () => {
      if (!transaction || !claim) throw new Error('missing transaction');
      const tx = transaction;
      if (!await tx.orgs.get(input.parentOrgId)) throw new BillingAccountError(422, 'member_not_eligible', input.parentOrgId);
      const account: BillingAccount = { id: randomUUID(), ...payload };
      await tx.insertAccount(account, claim);
      await tx.audit({ actorRef: actorReference(context.principalId), operation: 'create', accountId: account.id, orgIds: [account.parentOrgId], occurredAt: this.options.clock?.now() ?? await tx.now() });
      return { status: 201, body: { ...account } };
    });
    if (operationError instanceof BillingAccountError) throw operationError;
    if (!result.ok) throw new BillingAccountError(result.status, result.reason);
    return result.response.body as unknown as BillingAccount;
  }
  async members(caller: BillingCaller, accountId: string): Promise<string[]> {
    return this.options.store.transaction(async tx => {
      const account = await tx.getAccount(accountId);
      if (!account) throw new BillingAccountError(404, 'not_found');
      await authorizeBilling(caller, account.parentOrgId, this.options.authz);
      const members = await tx.listMembers(accountId);
      // A narrow admin grant must not disclose member organizations outside its coverage.
      for (const orgId of members) await requireCoverage(caller, orgId, this.options.authz);
      return members;
    });
  }
}
