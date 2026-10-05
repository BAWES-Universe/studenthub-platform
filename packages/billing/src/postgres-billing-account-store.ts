import type pg from 'pg';
import { BillingAccountError, type BillingAccount, type BillingAccountStore, type BillingTransaction } from './account.js';
import type { OrgRegistry, RegistryOrganization } from './membership.js';
/** Bind to the transaction client to keep hierarchy stable through commit. */
export class PostgresOrgRegistry implements OrgRegistry {
  constructor(readonly client: pg.PoolClient) {}
  async get(orgId: string): Promise<RegistryOrganization | undefined> {
    const { rows } = await this.client.query('SELECT id, parent_org_id AS "parentOrgId" FROM organizations WHERE id = $1 FOR SHARE', [orgId]);
    return rows[0];
  }
}
const columns = 'id, parent_org_id AS "parentOrgId", currency_code AS "currencyCode", bill_to AS "billTo"';
export class PostgresBillingAccountStore implements BillingAccountStore {
  constructor(readonly pool: pg.Pool) {}
  async transaction<T>(work: (tx: BillingTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const tx: BillingTransaction = {
        orgs: new PostgresOrgRegistry(client),
        now: async () => (await client.query('SELECT clock_timestamp() AS now')).rows[0].now,
        lockIdempotency: async input => { await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`billing-create:${input.principalRef}:${input.key}`]); },
        findReceipt: async input => {
          const { rows } = await client.query(`SELECT ${columns}, fingerprint FROM billing_account WHERE create_actor_ref = $1 AND idempotency_key = $2`, [input.principalRef, input.key]);
          if (!rows[0]) return undefined;
          const { fingerprint, ...account } = rows[0];
          return { fingerprint, account: account as BillingAccount };
        },
        getAccount: async id => (await client.query(`SELECT ${columns} FROM billing_account WHERE id = $1 FOR UPDATE`, [id])).rows[0],
        insertAccount: async (account, receipt) => {
          await client.query('INSERT INTO billing_account (id, parent_org_id, currency_code, bill_to, create_actor_ref, idempotency_key, fingerprint, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [account.id, account.parentOrgId, account.currencyCode, account.billTo, receipt.principalRef, receipt.key, receipt.fingerprint, receipt.expiresAt]);
        },
        listMembers: async id => (await client.query<{ org_id: string }>('SELECT org_id FROM billing_account_member WHERE account_id = $1 ORDER BY org_id', [id])).rows.map(row => row.org_id),
        attach: async (account, orgIds) => {
          for (const orgId of orgIds) {
            try {
              await client.query('INSERT INTO billing_account_member (account_id, org_id, currency_code) VALUES ($1,$2,$3) ON CONFLICT (account_id, org_id) DO NOTHING', [account.id, orgId, account.currencyCode]);
            } catch (error) {
              if ((error as { constraint?: string }).constraint === 'billing_member_org_currency') throw new BillingAccountError(409, 'member_account_exists', orgId);
              throw error;
            }
          }
        },
        detach: async (accountId, orgId) => { await client.query('DELETE FROM billing_account_member WHERE account_id = $1 AND org_id = $2', [accountId, orgId]); },
        audit: async event => { await client.query('INSERT INTO billing_account_audit (actor_ref, operation, account_id, org_ids, occurred_at) VALUES ($1,$2,$3,$4,$5)', [event.actorRef, event.operation, event.accountId, event.orgIds, event.occurredAt]); },
      };
      const result = await work(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      if ((error as { constraint?: string }).constraint === 'billing_account_parent_currency') throw new BillingAccountError(409, 'account_exists');
      throw error;
    } finally { client.release(broken); }
  }
}
