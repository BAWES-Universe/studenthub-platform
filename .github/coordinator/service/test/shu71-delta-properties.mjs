import assert from 'node:assert/strict';
import fs from 'node:fs';
export const productionSource = () => fs.readFileSync(new URL('../shu71-production.mjs', import.meta.url), 'utf8');
const compact = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/\s+/g, '');
// A reviewed source-shape contract, not a general JavaScript semantic proof.
export function exhaustedControl(source = productionSource()) {
  const body = source.slice(source.indexOf('async function cleanup('));
  const prefix = body.slice(0, body.indexOf('const effects = ['));
  assert.ok(prefix.includes('const reservations ='), 'SHU71_CONTROL_PROPERTY_EXHAUSTED_REGION');
  assert.ok(!/b\s*\.\s*now\s*\(/.test(prefix), 'SHU71_CONTROL_PROPERTY_EXHAUSTED_NO_CLOCK');
  const name = 'SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_CANONICAL_READ_ATTEMPTS_ONLY';
  // The prefix also contains this one reservation write. Pin it exactly before
  // excluding it; every other occurrence of the filename is inspected as a read.
  const write = 'else atomic(`${dir}/automatic-teardown.json`, JSON.stringify({ attempts: attempts + 1 }));';
  assert.equal(prefix.split(write).length, 2, name);
  const reads = prefix.replace(write, '');
  assert.equal([...reads.matchAll(/automatic-teardown\.json/g)].length, 1, name);
  const line = reads.split('\n').find(line => line.includes('automatic-teardown.json'));
  assert.equal(line?.trim(), 'try { attempts = JSON.parse(privateRead(`${dir}/automatic-teardown.json`)).attempts; }', name);
}
export function completionOrdering(source = productionSource()) {
  const start = source.indexOf("if (journal.entries.some(e => e.event === 'TEARDOWN_COMPLETE')) {");
  const end = source.indexOf("if (active && active.activation_id !== id) return { ok: false", start);
  const execute = source.slice(source.indexOf('async function execute'), start);
  assert.ok(start >= 0 && end > start && !execute.includes('await cleanup(')
    && compact(source.slice(start, end)).endsWith("return{ok:true,state:'REVOKED',activation_id:id,physical_teardown_observed:true};}")
    && source.indexOf('if (recovered)', end) > end
    && source.indexOf('if (attempts >= 32)', end) > end,
  'SHU71_CONTROL_PROPERTY_COMPLETION_BEFORE_EXHAUSTED');
}
// Exact append-site inventory includes dynamic expressions, not just string literals.
export const appendSites = {
  'shu71-production.mjs': [
    "{ event: 'APPROVED', spec }", "{ event: 'RUN_ATTEMPT_STARTED' }", "{ event: 'SIGNING_STARTED' }",
    "{ event: 'BROKER_RUNTIME_CHECK_STARTED' }",
    "{ event: 'BROKER_RUNTIME_MEASURED', ...runtime }",
    "{ event: 'ARMED', authorization_expires_at: pkg.expires_at, teardown_complete: false }",
    "{ event: 'HALTED', code, ...named, ...detail }", "{ event: 'EXPIRY_RETIREMENT_STARTED' }",
    "{ event: 'FIXTURE_REMOVE_INTENT', attempt_id: record.attempt_id, dev: st.dev, ino: st.ino, uid: st.uid }",
    "{ event: 'BRANCH_RESTORE_MEASURED', branch, ...measured }",
    "{ event: 'AUTOMATIC_TEARDOWN_RESERVED', attempts: attempts + 1 }", "{ event: 'SETTLEMENT_STARTED' }",
  ],
  'shu71-journal.mjs': ["{ event: 'INTENT', step }", "{ event: 'DONE', step }",
    "{ event: reason === 'expiry' ? 'AUTHORIZATION_EXPIRED' : 'REVOKE_REQUESTED' }", '{ event, failures }'],
};
export function inventoryGuard(inventory, overrides = {}) {
  assert.deepEqual(inventory.filter(e => e.terminal).map(e => e.event), ['TEARDOWN_COMPLETE'], 'SHU71_CONTROL_PROPERTY_JOURNAL_TERMINAL_CLASSIFICATION');
  for (const [file, sites] of Object.entries(appendSites)) {
    const source = overrides[file] ?? fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const calls = [...source.matchAll(/journal\s*\.\s*append\s*\(([^]*?)\);/g)].map(m => compact(m[1]));
    assert.deepEqual(calls, sites.map(compact), 'SHU71_CONTROL_PROPERTY_JOURNAL_APPEND_INVENTORY');
    if (file === 'shu71-journal.mjs') assert.ok(source.includes("const event = failures.length ? 'TEARDOWN_INCOMPLETE' : 'TEARDOWN_COMPLETE';"), 'SHU71_CONTROL_PROPERTY_JOURNAL_DYNAMIC_CLASSES');
  }
  const classes = Object.values(appendSites).flat().join(' ').match(/'[A-Z_]+'/g).map(s => s.slice(1, -1));
  classes.push('TEARDOWN_INCOMPLETE', 'TEARDOWN_COMPLETE');
  assert.deepEqual(inventory.map(v => v.event).sort(), classes.sort(), 'SHU71_CONTROL_PROPERTY_JOURNAL_CLASS_COVERAGE');
}
