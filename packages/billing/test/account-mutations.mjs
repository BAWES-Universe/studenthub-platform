/** SHU-263: built-code mutation proof. Every named failure must be an assertion,
 * never a parser/import/connection failure. PostgreSQL mutants require DATABASE_URL. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../../../', import.meta.url);
const unit = fileURLToPath(new URL('dist/packages/billing/test/account.test.js', root));
const postgres = fileURLToPath(new URL('dist/packages/billing/test/account-postgres.test.js', root));
const source = name => new URL(`dist/packages/billing/src/${name}.js`, root);
const mutations = [
  ['allow grandchildren', 'SHU-263/AC-01 foreign-company-injection', 'membership',
    'org.parentOrgId === account.parentOrgId)', '(org.parentOrgId === account.parentOrgId || (org.parentOrgId && (await tx.orgs.get(org.parentOrgId))?.parentOrgId === account.parentOrgId)))', false],
  ['drop member coverage', 'SHU-263/AC-02 attach-requires-coverage', 'account',
    "if (result.kind !== 'authorized')\n        throw new BillingAccountError(422, 'member_not_eligible', orgId);", '', false],
  ['derive members from ancestry', 'SHU-263/AC-03 membership-is-explicit', 'postgres-billing-account-store',
    'SELECT org_id FROM billing_account_member WHERE account_id = $1 ORDER BY org_id',
    'SELECT id AS org_id FROM organizations WHERE parent_org_id = (SELECT parent_org_id FROM billing_account WHERE id = $1) ORDER BY id', true],
  ['skip open-lines port', 'SHU-263/AC-04 detach-open-lines', 'membership',
    'if (await this.options.openLines.hasOpenLines(orgId))', 'if (false)', false],
  ['drop unique account index', 'SHU-263/AC-05 one-account-per-currency', 'postgres-billing-account-store',
    'insertAccount: async (account, receipt) => {', 'insertAccount: async (account, receipt) => { await client.query("DROP INDEX IF EXISTS billing_account_parent_currency");', true],
  ['write audit outside transaction', 'SHU-263/AC-06 audit-atomic', 'postgres-billing-account-store',
    'audit: async (event) => {', 'audit: async (event) => { await client.query("COMMIT");', true],
  ['allow unlisted role', 'SHU-263/AC-07 policy-denies-by-default', 'account',
    'Object.values(BILLING_ACCOUNT_POLICY).find(rule => rule.role === context.role)',
    'Object.values(BILLING_ACCOUNT_POLICY).find(rule => rule.role === context.role) ?? BILLING_ACCOUNT_POLICY.admin', false],
  ['corrupt bill-to mapping', 'SHU-263/parity-contract', 'account',
    'billTo: input.billTo };', "billTo: 'Wrong synthetic recipient' };", true],
];
function run(suite, title) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...(title ? [`--test-name-pattern=^${title}$`] : []), suite], { encoding: 'utf8', timeout: 90_000, env: process.env });
  return { ...result, output: (result.stdout ?? '') + (result.stderr ?? '') };
}
const db = Boolean(process.env.DATABASE_URL);
const suites = [unit, ...(db ? [postgres] : [])];
for (const suite of suites) { const baseline = run(suite); assert.equal(baseline.status, 0, `baseline must pass\n${baseline.output}`); }
let killed = 0;
for (const [name, title, module, from, to, needsDb] of mutations) {
  if (needsDb && !db) continue;
  const target = source(module), original = await readFile(target, 'utf8');
  assert.equal(original.split(from).length - 1, 1, `${name}: mutation must bind exactly once`);
  try {
    await writeFile(target, original.replace(from, to));
    const result = run(needsDb ? postgres : unit, title);
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name}: survived\n${result.output}`);
    assert.ok(result.output.includes(`- ${title}`) && /not ok \d+ -/.test(result.output), `${name}: named test did not fail\n${result.output}`);
    assert.doesNotMatch(result.output, /SyntaxError|ERR_MODULE_NOT_FOUND|ECONNREFUSED|ENOTFOUND/, `${name}: infrastructure failure\n${result.output}`);
    assert.match(result.output, /code: 'ERR_ASSERTION'/, `${name}: must fail by assertion\n${result.output}`);
    killed++;
    process.stdout.write(`KILLED ${name} -> ${title}\n`);
  } finally { await writeFile(target, original); }
}
for (const suite of suites) { const restored = run(suite); assert.equal(restored.status, 0, `restored suite must pass\n${restored.output}`); }
process.stdout.write(`${killed}/${db ? mutations.length : mutations.filter(m => !m[5]).length} SHU-263 mutations killed; restored suites green\n`);
if (!db) process.stdout.write('PostgreSQL mutations deferred: rerun with DATABASE_URL pointing to a scratch database (required before PR).\n');
