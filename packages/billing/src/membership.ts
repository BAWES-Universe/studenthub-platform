import { actorReference, authorizeBilling, requireCoverage, validText, BillingAccountError, type BillingCaller, type BillingOptions } from './account.js';
export interface RegistryOrganization { readonly id: string; readonly parentOrgId: string | null }
export interface OrgRegistry { get(orgId: string): Promise<RegistryOrganization | undefined> }
/** F4.3 draft-line writers must lock billing_account FOR UPDATE, then recheck
 * explicit membership before inserting lines. Detach holds that same account lock
 * while calling this port, so the query must not try to reacquire the lock.
 * Implementations must fail closed; errors propagate and roll back the detach. */
export interface OpenLinesPort { hasOpenLines(orgId: string): Promise<boolean> }
export class BillingMembership {
  constructor(readonly options: BillingOptions) {}
  async attach(caller: BillingCaller, accountId: string, ids: readonly string[]): Promise<void> {
    if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => !validText(id))) throw new BillingAccountError(400, 'invalid_input');
    const orgIds = [...new Set(ids)].sort();
    await this.options.store.transaction(async tx => {
      const account = await tx.getAccount(accountId);
      if (!account) throw new BillingAccountError(404, 'not_found');
      const context = await authorizeBilling(caller, account.parentOrgId, this.options.authz);
      for (const orgId of orgIds) {
        const org = await tx.orgs.get(orgId);
        if (!org || !(org.id === account.parentOrgId || org.parentOrgId === account.parentOrgId)) throw new BillingAccountError(422, 'member_not_eligible', orgId);
        await requireCoverage(caller, orgId, this.options.authz);
      }
      await tx.attach(account, orgIds);
      await tx.audit({ actorRef: actorReference(context.principalId), operation: 'attach', accountId, orgIds, occurredAt: this.options.clock?.now() ?? await tx.now() });
    });
  }
  async detach(caller: BillingCaller, accountId: string, orgId: string): Promise<void> {
    await this.options.store.transaction(async tx => {
      const account = await tx.getAccount(accountId);
      if (!account) throw new BillingAccountError(404, 'not_found');
      const context = await authorizeBilling(caller, account.parentOrgId, this.options.authz);
      await requireCoverage(caller, orgId, this.options.authz);
      if (await this.options.openLines.hasOpenLines(orgId)) throw new BillingAccountError(409, 'member_has_open_lines', orgId);
      await tx.detach(accountId, orgId);
      await tx.audit({ actorRef: actorReference(context.principalId), operation: 'detach', accountId, orgIds: [orgId], occurredAt: this.options.clock?.now() ?? await tx.now() });
    });
  }
}
