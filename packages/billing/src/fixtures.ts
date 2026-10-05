/** Synthetic-only adapters and fixtures; never used as production persistence. */
import { InMemoryAuthzStore, createPrincipal, type AuthzStore } from '@studenthub/contracts';
import { BillingAccountError, type BillingAccount, type BillingAccountStore, type BillingTransaction, type BillingAudit, type BillingCaller } from './account.js';
import type { AtomicMutationInput } from '../../idempotency-contract/src/index.js';
import type { OrgRegistry, RegistryOrganization, OpenLinesPort } from './membership.js';
export const FIXED_BILLING_TIME = new Date('2026-10-05T12:00:00.000Z');
export const BILLING_FIXTURE_ORGS = [
  { id: 'A', name: 'Synthetic A' }, { id: 'A1', name: 'Synthetic A1', parentOrgId: 'A' },
  { id: 'A2', name: 'Synthetic A2', parentOrgId: 'A' }, { id: 'A1x', name: 'Synthetic A1x', parentOrgId: 'A1' }, { id: 'B', name: 'Synthetic B' },
];
export const billingCaller = (principalId: string, role = principalId.startsWith('admin') ? 'admin' : principalId === 'candidate' ? 'candidate' : 'org-owner'): BillingCaller => ({ identity: { kind: 'principal', principalId }, role });
export async function seedBillingAuthz(store: AuthzStore = new InMemoryAuthzStore()): Promise<AuthzStore> {
  for (const org of BILLING_FIXTURE_ORGS) await store.upsertOrganization(org);
  for (const id of ['admin', 'admin-self', 'owner-A', 'owner-self', 'owner-B', 'candidate']) await store.registerPrincipal(createPrincipal({ id, pbuuids: [] }));
  await store.grantMany('admin', [{ orgId: 'A', role: 'admin', scope: 'subtree' }, { orgId: 'B', role: 'admin', scope: 'subtree' }]);
  await store.grantMany('admin-self', [{ orgId: 'A', role: 'admin', scope: 'self' }]);
  await store.grantMany('owner-A', [{ orgId: 'A', role: 'org-owner', scope: 'subtree' }]);
  await store.grantMany('owner-self', [{ orgId: 'A', role: 'org-owner', scope: 'self' }]);
  await store.grantMany('owner-B', [{ orgId: 'B', role: 'org-owner', scope: 'subtree' }]);
  await store.grantMany('candidate', [{ orgId: 'A', role: 'candidate', scope: 'subtree' }]);
  return store;
}
export class FixtureOrgRegistry implements OrgRegistry {
  readonly rows = new Map<string, RegistryOrganization>(BILLING_FIXTURE_ORGS.map(org => [org.id, { id: org.id, parentOrgId: org.parentOrgId ?? null }]));
  async get(id: string): Promise<RegistryOrganization | undefined> { const row = this.rows.get(id); return row && { ...row }; }
}
export class FixtureOpenLines implements OpenLinesPort {
  readonly orgIds = new Set<string>();
  async hasOpenLines(orgId: string): Promise<boolean> { return this.orgIds.has(orgId); }
}
interface State { accounts: BillingAccount[]; members: { accountId: string; orgId: string; currencyCode: string }[]; audits: BillingAudit[]; receipts: { input: AtomicMutationInput; account: BillingAccount }[] }
export class FixtureBillingAccountStore implements BillingAccountStore {
  readonly orgs = new FixtureOrgRegistry();
  state: State = { accounts: [], members: [], audits: [], receipts: [] };
  failAudit = false;
  private tail = Promise.resolve();
  constructor(readonly now = () => new Date(FIXED_BILLING_TIME)) {}
  async transaction<T>(work: (tx: BillingTransaction) => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await prior;
    const draft = structuredClone(this.state);
    try {
      const tx: BillingTransaction = {
        orgs: this.orgs, now: async () => this.now(), lockIdempotency: async () => {},
        findReceipt: async input => { const row = draft.receipts.find(r => r.input.principalRef === input.principalRef && r.input.key === input.key); return row && { fingerprint: row.input.fingerprint, account: row.account }; },
        getAccount: async id => draft.accounts.find(a => a.id === id),
        insertAccount: async (account, input) => {
          if (draft.accounts.some(a => a.parentOrgId === account.parentOrgId && a.currencyCode === account.currencyCode)) throw new BillingAccountError(409, 'account_exists');
          draft.accounts.push(account); draft.receipts.push({ input, account });
        },
        listMembers: async accountId => draft.members.filter(m => m.accountId === accountId).map(m => m.orgId).sort(),
        attach: async (account, orgIds) => {
          for (const orgId of orgIds) {
            const old = draft.members.find(m => m.orgId === orgId && m.currencyCode === account.currencyCode);
            if (old && old.accountId !== account.id) throw new BillingAccountError(409, 'member_account_exists', orgId);
            if (!old) draft.members.push({ accountId: account.id, orgId, currencyCode: account.currencyCode });
          }
        },
        detach: async (accountId, orgId) => { draft.members = draft.members.filter(m => !(m.accountId === accountId && m.orgId === orgId)); },
        audit: async event => { if (this.failAudit) throw new Error('synthetic audit failure'); draft.audits.push(event); },
      };
      const result = await work(tx);
      this.state = structuredClone(draft);
      return structuredClone(result);
    } finally { release(); }
  }
}
