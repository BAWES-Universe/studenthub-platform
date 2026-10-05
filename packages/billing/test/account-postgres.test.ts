import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import pg from 'pg';
import { PostgresAuthzStore, runMigrations } from '@studenthub/db';
import { BillingAccounts, BillingAccountError, actorReference } from '../src/account.js';
import { BillingMembership } from '../src/membership.js';
import { PostgresBillingAccountStore } from '../src/postgres-billing-account-store.js';
import { FixtureOpenLines, seedBillingAuthz, billingCaller } from '../src/fixtures.js';
import { createIdempotencyKey } from '../../idempotency-contract/src/index.js';
const admin = billingCaller('admin');
const input = { parentOrgId: 'A', currencyCode: 'KWD', billTo: 'Synthetic A billing' };
const error = (code: string, status: number, orgId?: string) => (e: unknown): boolean => e instanceof BillingAccountError && e.code === code && e.status === status && (orgId === undefined || e.orgId === orgId);
async function fixture(t: TestContext) {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to a scratch PostgreSQL 16/17');
  const connectionString = process.env.DATABASE_URL;
  const schema = `shu263_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new pg.Pool({ connectionString });
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const config = { connectionString, options: `-c search_path=${schema}` };
  const pool = new pg.Pool(config), authz = new PostgresAuthzStore(config);
  t.after(async () => { await authz.close(); await pool.end(); try { await adminPool.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await adminPool.end(); } });
  assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema);
  await runMigrations(pool);
  await seedBillingAuthz(authz);
  // Fixed for this entire test, while expiry is still enforced by PostgreSQL's clock.
  const instant = new Date(), clock = { now: () => new Date(instant) };
  const store = new PostgresBillingAccountStore(pool), openLines = new FixtureOpenLines();
  const options = { store, authz, openLines, clock };
  const accounts = new BillingAccounts(options), membership = new BillingMembership(options);
  const key = () => createIdempotencyKey(clock.now());
  const account = await accounts.create(admin, input, key());
  const audit = async () => (await pool.query('SELECT actor_ref, operation, account_id, org_ids, occurred_at FROM billing_account_audit ORDER BY id')).rows;
  return { pool, authz, store, openLines, accounts, membership, account, key, audit, clock };
}
async function failAudit(pool: pg.Pool) {
  await pool.query(`CREATE FUNCTION fail_billing_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END; $$;
    CREATE TRIGGER fail_billing_audit BEFORE INSERT ON billing_account_audit FOR EACH ROW EXECUTE FUNCTION fail_billing_audit();`);
}

test('SHU-263/AC-03 membership-is-explicit', async t => {
  const f = await fixture(t);
  await f.membership.attach(admin, f.account.id, ['A1']);
  assert.equal((await f.pool.query("SELECT parent_org_id FROM organizations WHERE id = 'A2'")).rows[0].parent_org_id, 'A');
  assert.deepEqual(await f.accounts.members(admin, f.account.id), ['A1']);
  // Changing registry ancestry must not silently change an already explicit set.
  await f.pool.query("UPDATE organizations SET parent_org_id = 'B' WHERE id = 'A1'");
  assert.deepEqual(await f.accounts.members(admin, f.account.id), ['A1']);
  const restarted = new BillingAccounts({ store: new PostgresBillingAccountStore(f.pool), authz: f.authz, openLines: f.openLines, clock: f.clock });
  assert.deepEqual(await restarted.members(admin, f.account.id), ['A1']);
});
test('SHU-263/AC-05 one-account-per-currency', async t => {
  const f = await fixture(t);
  await assert.rejects(f.accounts.create(admin, input, f.key()), error('account_exists', 409));
  const second = await f.accounts.create(admin, { ...input, currencyCode: 'BHD' }, f.key());
  assert.notEqual(second.id, f.account.id);
  // Independent SQL insertion proves uniqueness comes from the real DB index.
  await assert.rejects(f.pool.query(`INSERT INTO billing_account (id,parent_org_id,currency_code,bill_to,create_actor_ref,idempotency_key,fingerprint,expires_at)
    SELECT $1,parent_org_id,currency_code,bill_to,create_actor_ref,$2,fingerprint,expires_at FROM billing_account WHERE id=$3`, [randomUUID(), f.key(), f.account.id]), { code: '23505', constraint: 'billing_account_parent_currency' });
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM billing_account')).rows[0].n, 2);
});
test('SHU-263/AC-06 audit-atomic', async t => {
  const f = await fixture(t), key = f.key();
  await failAudit(f.pool);
  await assert.rejects(f.accounts.create(admin, { ...input, currencyCode: 'BHD' }, key), error('operation_failed', 503));
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM billing_account')).rows[0].n, 1, 'failed create must roll back account and receipt');
  await assert.rejects(f.membership.attach(admin, f.account.id, ['A', 'A1']));
  assert.deepEqual(await f.accounts.members(admin, f.account.id), [], 'failed attach must roll back all members');
  assert.equal((await f.audit()).length, 1);
  await f.pool.query('DROP TRIGGER fail_billing_audit ON billing_account_audit');
  await f.accounts.create(admin, { ...input, currencyCode: 'BHD' }, key);
  await f.membership.attach(admin, f.account.id, ['A1']);
  await f.pool.query('CREATE TRIGGER fail_billing_audit BEFORE INSERT ON billing_account_audit FOR EACH ROW EXECUTE FUNCTION fail_billing_audit()');
  await assert.rejects(f.membership.detach(admin, f.account.id, 'A1'));
  assert.deepEqual(await f.accounts.members(admin, f.account.id), ['A1'], 'failed detach must retain membership');
  assert.deepEqual((await f.audit()).map(a => a.operation), ['create', 'create', 'attach']);
});
test('SHU-263/parity-contract', async t => {
  const f = await fixture(t), owner = billingCaller('owner-A');
  assert.deepEqual({ ...f.account, id: 'generated' }, { id: 'generated', ...input });
  for (const orgId of ['A1x', 'B']) await assert.rejects(f.membership.attach(admin, f.account.id, ['A1', orgId]), error('member_not_eligible', 422, orgId));
  await assert.rejects(f.membership.attach(billingCaller('owner-self'), f.account.id, ['A1']), error('denied', 403));
  await assert.rejects(f.membership.attach(billingCaller('admin-self'), f.account.id, ['A1']), error('member_not_eligible', 422, 'A1'));
  await f.membership.attach(owner, f.account.id, ['A', 'A1']);
  assert.deepEqual(await f.accounts.members(admin, f.account.id), ['A', 'A1']);
  f.openLines.orgIds.add('A1');
  await assert.rejects(f.membership.detach(owner, f.account.id, 'A1'), error('member_has_open_lines', 409));
  f.openLines.orgIds.clear();
  await f.membership.detach(owner, f.account.id, 'A1');
  assert.deepEqual(await f.accounts.members(admin, f.account.id), ['A']);
  await assert.rejects(f.accounts.create(admin, input, f.key()), error('account_exists', 409));
  await f.accounts.create(admin, { ...input, currencyCode: 'BHD' }, f.key());
  for (const caller of [billingCaller('candidate'), billingCaller('owner-B'), { role: 'admin' }]) {
    await assert.rejects(f.accounts.create(caller, input, f.key()), error('denied', 403));
    await assert.rejects(f.membership.attach(caller, f.account.id, ['A2']), error('denied', 403));
    await assert.rejects(f.membership.detach(caller, f.account.id, 'A'), error('denied', 403));
  }
  const rows = await f.audit();
  assert.deepEqual(rows.map(a => a.operation), ['create', 'attach', 'detach', 'create']);
  assert.deepEqual(rows.map(a => a.org_ids), [['A'], ['A', 'A1'], ['A1'], ['A']]);
  assert.deepEqual(rows.map(a => a.actor_ref), [actorReference('admin'), actorReference('owner-A'), actorReference('owner-A'), actorReference('admin')]);
  assert.ok(rows.every(a => a.occurred_at.getTime() === f.clock.now().getTime()));
  await failAudit(f.pool);
  await assert.rejects(f.membership.attach(admin, f.account.id, ['A2']));
  assert.deepEqual(await f.accounts.members(admin, f.account.id), ['A']);
});
test('Postgres concurrent idempotent creates persist one account, receipt and audit across restart', async t => {
  const f = await fixture(t), key = f.key(), bhd = { ...input, currencyCode: 'BHD' };
  const results = await Promise.all(Array.from({ length: 8 }, () => f.accounts.create(admin, bhd, key)));
  assert.ok(results.every(a => a.id === results[0].id));
  assert.equal((await f.audit()).length, 2);
  const restarted = new BillingAccounts({ store: new PostgresBillingAccountStore(f.pool), authz: f.authz, openLines: f.openLines, clock: f.clock });
  assert.deepEqual(await restarted.create(admin, bhd, key), results[0]);
  await assert.rejects(restarted.create(admin, { ...bhd, billTo: 'Changed' }, key), error('key_payload_mismatch', 409));
  await f.authz.clearGrantsForPrincipal('admin');
  await assert.rejects(restarted.create(admin, bhd, key), error('denied', 403));
  await assert.rejects(f.membership.attach(admin, f.account.id, ['A1']), error('denied', 403));
  await assert.rejects(f.membership.detach(admin, f.account.id, 'A1'), error('denied', 403));
});
test('Postgres member uniqueness is per currency, atomic across a set and concurrent accounts', async t => {
  const f = await fixture(t);
  const child = await f.accounts.create(admin, { ...input, parentOrgId: 'A1' }, f.key());
  const bhd = await f.accounts.create(admin, { ...input, currencyCode: 'BHD' }, f.key());
  await f.membership.attach(admin, child.id, ['A1']);
  await assert.rejects(f.membership.attach(admin, f.account.id, ['A', 'A1']), error('member_account_exists', 409, 'A1'));
  assert.deepEqual(await f.accounts.members(admin, f.account.id), []);
  await f.membership.attach(admin, bhd.id, ['A1']);
  await f.membership.detach(admin, child.id, 'A1');
  const outcomes = await Promise.allSettled([f.membership.attach(admin, child.id, ['A1']), f.membership.attach(admin, f.account.id, ['A1'])]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(o => o.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && error('member_account_exists', 409, 'A1')(rejected.reason));
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM billing_account_member WHERE org_id='A1' AND currency_code='KWD'")).rows[0].n, 1);
});
test('Postgres transaction clock rejects an expired claim even when caller clock is stale', async t => {
  const f = await fixture(t);
  const clock = { now: () => new Date('2020-01-01T00:00:00Z') };
  const stale = new BillingAccounts({ store: f.store, authz: f.authz, openLines: f.openLines, clock });
  await assert.rejects(stale.create(admin, { ...input, currencyCode: 'BHD' }, createIdempotencyKey(clock.now())), error('key_expired', 409));
  assert.equal((await f.audit()).length, 1);
});
