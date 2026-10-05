import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BillingAccounts, BillingAccountError, type BillingAccountStore } from '../src/account.js';
import { BillingMembership } from '../src/membership.js';
import { FixtureBillingAccountStore, FixtureOpenLines, seedBillingAuthz, billingCaller, FIXED_BILLING_TIME } from '../src/fixtures.js';
import { createIdempotencyKey } from '../../idempotency-contract/src/index.js';
const clock = { now: () => new Date(FIXED_BILLING_TIME) };
const input = { parentOrgId: 'A', currencyCode: 'KWD', billTo: 'Synthetic A billing' };
const admin = billingCaller('admin');
async function fixture() {
  const store = new FixtureBillingAccountStore(), authz = await seedBillingAuthz(), openLines = new FixtureOpenLines();
  const options = { store, authz, openLines, clock };
  const accounts = new BillingAccounts(options), membership = new BillingMembership(options);
  const account = await accounts.create(admin, input, createIdempotencyKey(clock.now()));
  return { store, authz, openLines, accounts, membership, account };
}
const error = (code: string, status: number, orgId?: string) => (e: unknown): boolean => e instanceof BillingAccountError && e.code === code && e.status === status && (orgId === undefined || e.orgId === orgId);

test('SHU-263/AC-01 foreign-company-injection', async () => {
  const f = await fixture();
  for (const bad of ['A1x', 'B', 'missing']) {
    await assert.rejects(f.membership.attach(admin, f.account.id, ['A1', bad]), error('member_not_eligible', 422, bad));
    assert.deepEqual(await f.accounts.members(admin, f.account.id), []);
    assert.equal(f.store.state.audits.length, 1);
  }
  await f.membership.attach(billingCaller('owner-A'), f.account.id, ['A', 'A1', 'A1']);
  assert.deepEqual(await f.accounts.members(admin, f.account.id), ['A', 'A1']);
});
test('SHU-263/AC-02 attach-requires-coverage', async () => {
  const f = await fixture();
  await assert.rejects(f.membership.attach(billingCaller('owner-self'), f.account.id, ['A1']), error('denied', 403));
  // Admin is allowed at A but a self grant covers neither child. This isolates
  // member coverage from the owner's separate subtree-policy requirement.
  await assert.rejects(f.membership.attach(billingCaller('admin-self'), f.account.id, ['A', 'A1']), error('member_not_eligible', 422, 'A1'));
  await f.authz.grantMany('admin-self', [{ orgId: 'A1', role: 'finance', scope: 'self' }]);
  await assert.rejects(f.membership.attach(billingCaller('admin-self'), f.account.id, ['A1']), error('member_not_eligible', 422, 'A1'));
  assert.deepEqual(await f.accounts.members(admin, f.account.id), []);
  await f.authz.grantMany('admin-self', [{ orgId: 'A1', role: 'admin' }]);
  await f.membership.attach(billingCaller('admin-self'), f.account.id, ['A1']);
});
test('SHU-263/AC-04 detach-open-lines', async () => {
  const f = await fixture();
  await f.membership.attach(admin, f.account.id, ['A1']);
  f.openLines.orgIds.add('A1');
  await assert.rejects(f.membership.detach(admin, f.account.id, 'A1'), error('member_has_open_lines', 409, 'A1'));
  assert.deepEqual(await f.accounts.members(admin, f.account.id), ['A1']);
  assert.equal(f.store.state.audits.length, 2);
  f.openLines.orgIds.clear();
  await f.membership.detach(admin, f.account.id, 'A1');
  assert.deepEqual(await f.accounts.members(admin, f.account.id), []);
  assert.deepEqual(f.store.state.audits.map(a => a.operation), ['create', 'attach', 'detach']);
  assert.deepEqual(f.store.state.audits[2].occurredAt, FIXED_BILLING_TIME);
});
test('SHU-263/AC-07 policy-denies-by-default', async () => {
  const f = await fixture();
  for (const caller of [billingCaller('candidate'), billingCaller('owner-B'), { role: 'admin' }, billingCaller('owner-self'), billingCaller('unknown', 'admin')]) {
    await assert.rejects(f.accounts.create(caller, input, createIdempotencyKey(clock.now())), error('denied', 403));
    await assert.rejects(f.membership.attach(caller, f.account.id, ['A1']), error('denied', 403));
    await assert.rejects(f.membership.detach(caller, f.account.id, 'A1'), error('denied', 403));
  }
  assert.equal(f.store.state.audits.length, 1);
});
test('create idempotency fingerprints input and rechecks revoked authority', async () => {
  const f = await fixture(), key = createIdempotencyKey(clock.now());
  const bhd = { ...input, currencyCode: 'BHD' }, owner = billingCaller('owner-A');
  const [first, retry] = await Promise.all([f.accounts.create(owner, bhd, key), f.accounts.create(owner, bhd, key.toUpperCase())]);
  assert.deepEqual(first, retry);
  assert.equal(f.store.state.audits.length, 2);
  await assert.rejects(f.accounts.create(owner, { ...bhd, billTo: 'Changed' }, key), error('key_payload_mismatch', 409));
  await f.authz.clearGrantsForPrincipal('owner-A');
  for (const operation of [() => f.accounts.create(owner, bhd, key), () => f.membership.attach(owner, first.id, ['A1']), () => f.membership.detach(owner, first.id, 'A1')]) await assert.rejects(operation, error('denied', 403));
  await assert.rejects(f.accounts.create(admin, bhd), error('missing_key', 400));
  await assert.rejects(f.accounts.create(admin, bhd, 'bad'), error('invalid_key', 400));
  await assert.rejects(f.accounts.create(admin, bhd, createIdempotencyKey(new Date('2020-01-01'))), error('key_expired', 409));
});
test('fixture transactions discard account, membership and receipt on audit failure', async () => {
  const f = await fixture(), key = createIdempotencyKey(clock.now());
  f.store.failAudit = true;
  await assert.rejects(f.accounts.create(admin, { ...input, currencyCode: 'BHD' }, key), error('operation_failed', 503));
  await assert.rejects(f.membership.attach(admin, f.account.id, ['A1']));
  assert.equal(f.store.state.accounts.length, 1);
  assert.deepEqual(await f.accounts.members(admin, f.account.id), []);
  assert.equal(f.store.state.receipts.length, 1);
  f.store.failAudit = false;
  await f.accounts.create(admin, { ...input, currencyCode: 'BHD' }, key);
  await f.membership.attach(admin, f.account.id, ['A1']);
  f.store.failAudit = true;
  await assert.rejects(f.membership.detach(admin, f.account.id, 'A1'));
  assert.deepEqual(await f.accounts.members(admin, f.account.id), ['A1']);
});
test('invalid currency and bill-to are refused without writes', async () => {
  const f = await fixture();
  for (const bad of [{ ...input, currencyCode: 'kwd' }, { ...input, currencyCode: '' }, { ...input, billTo: ' ' }]) await assert.rejects(f.accounts.create(admin, bad, createIdempotencyKey(clock.now())), error('invalid_input', 400));
  assert.equal(f.store.state.accounts.length, 1);
});
test('identity rebinding between preflight and transaction cannot misattribute actor or idempotency', async () => {
  const f = await fixture();
  await f.authz.registerPrincipal({ id: 'admin', pbuuids: ['synthetic-login'] });
  await f.authz.grantMany('owner-A', [{ orgId: 'A', role: 'admin', scope: 'subtree' }]);
  const store: BillingAccountStore = { transaction: async work => {
    await f.authz.registerPrincipal({ id: 'admin', pbuuids: [] });
    await f.authz.registerPrincipal({ id: 'owner-A', pbuuids: ['synthetic-login'] });
    return f.store.transaction(work);
  } };
  const accounts = new BillingAccounts({ store, authz: f.authz, openLines: f.openLines, clock });
  await assert.rejects(accounts.create({ identity: { kind: 'pbuuid', pbuuid: 'synthetic-login' }, role: 'admin' }, { ...input, currencyCode: 'BHD' }, createIdempotencyKey(clock.now())), error('denied', 403));
  assert.equal(f.store.state.accounts.length, 1);
  assert.equal(f.store.state.audits.length, 1);
});
