import assert from 'node:assert/strict';
import { digest } from '../shu71-journal.mjs';
const activation = '/srv/shu/state/shu71-activation.json';
const gates = ['coordinator', 'supervisor'].map(n => `/etc/systemd/system/shu-${n}.service.d/90-shu71.conf`);
export const trustChecks = {
  async installation(create, h) {
    const run = h.boundary.run;
    h.boundary.run = (exe, args, opts) => args.includes('hash-object') && !args.includes('-t') ? { status: 0, stdout: 'f'.repeat(40) } : run(exe, args, opts);
    assert.equal((await create(h.id, h.boundary).execute('run')).code, 'ACT_CODE_BINDING', 'B1_CODE_BINDING');
    assert.equal(h.signatures(), 0, 'B1_CODE_BINDING_BEFORE_SIGN');
  },
  async transition(create, h) {
    const fetch = h.boundary.fetch;
    h.boundary.fetch = (url, opts) => url.includes('linear.app') && JSON.parse(opts.body).query.startsWith('mutation')
      ? Promise.resolve({ ok: true, text: async () => JSON.stringify({ data: { issueUpdate: { success: true } } }) }) : fetch(url, opts);
    assert.equal((await create(h.id, h.boundary).execute('run')).code, 'ACT_PARTIAL_ARMING', 'B1_TRANSITION_READBACK');
    assert.equal(h.exists(activation), false, 'B1_TRANSITION_NO_ACTIVATION');
  },
  async durability(create, h) {
    assert.equal((await create(h.id, h.boundary).execute('run')).state, 'ARMED', 'B4_DURABILITY_BASELINE');
    // Fixed expected files, independent of the implementation's observed event list.
    const dir = `/srv/shu/state/shu71-evidence/${h.id}`;
    for (const file of [`${dir}/custody.json`, '/srv/shu/state/shu71-evidence/active.json', `${dir}/signed-package.json`,
      `/etc/systemd/system/shu71-expiry-${h.id}.service`, `/etc/systemd/system/shu71-expiry-${h.id}.timer`,
      '/etc/systemd/system/shu71-evidence.service', activation, ...gates]) {
      const write = h.events.indexOf(`write:${file}.pending`), sync = h.events.indexOf(`fsync:${file}.pending`), rename = h.events.indexOf(`rename:${file}`);
      const parentSync = h.events.indexOf(`fsync:${file.slice(0, file.lastIndexOf('/'))}`, rename);
      assert.ok(write >= 0 && sync > write && rename > sync && parentSync > rename, `B4_ATOMIC_DURABILITY:${file}`);
    }
  },
  async conflict(create, h) {
    h.write('/srv/shu/state/shu71-evidence/active.json', JSON.stringify({ activation_id: 'other-episode' }));
    h.write(activation, 'successor');
    assert.equal((await create(h.id, h.boundary).execute('run')).code, 'ACT_ACTIVATION_CONFLICT', 'B1_ACTIVE_CONFLICT');
    assert.equal(h.read(activation), 'successor', 'B1_SUCCESSOR_UNTOUCHED');
    assert.equal(h.signatures(), 0, 'B1_CONFLICT_BEFORE_SIGN');
  },
  async owner(create, h) {
    const file = `/etc/shu/approvals/${h.id}.shu71.json`, doc = JSON.parse(h.read(file));
    doc.payload.tree = 'f'.repeat(40); h.write(file, JSON.stringify(doc));
    // A pre-arm refusal is RETURNED as a named halt now rather than escaping
    // the module to be printed as one fixed string. The refusal, its code and
    // its position before any signing are unchanged.
    const result = await create(h.id, h.boundary).execute('run').catch(error => ({ code: `threw:${error?.code}` }));
    assert.equal(result.code, 'ACT_OWNER_APPROVAL', 'B1_OWNER_ED25519');
    assert.equal(result.state, 'HALT', 'B1_OWNER_ED25519');
    assert.equal(h.signatures(), 0, 'B1_OWNER_BEFORE_SIGN');
  },
  async receipt(create, h) {
    assert.equal((await create(h.id, h.boundary).execute('run')).state, 'ARMED', 'B4_RECEIPT_SETUP');
    assert.equal((await create(h.id, h.boundary).execute('revoke')).state, 'REVOKED', 'B4_RECEIPT_SETUP');
    h.write(gates[0], '[Service]\nEnvironment=ENABLE_DISPATCH=true\n', 0o644);
    h.write(activation, 'rearmed');
    const result = await create(h.id, h.boundary).execute('revoke');
    assert.equal(result.code, 'ACT_TEARDOWN_DRIFT', 'B4_RECEIPT_OBSERVES_GATE');
    assert.equal(result.ok, false, 'B4_NO_FALSE_REVOKED');
  },
};
export function journalCheck(open, h, kind) {
  const dir = `/srv/shu/state/shu71-evidence/${h.id}`, file = `${dir}/journal.jsonl`;
  h.write(file, '');
  const journal = open(dir, h.boundary.fs, 'journal.jsonl', h.identity); journal.append({ event: 'APPROVED' }); journal.append({ event: 'ARMED' }); journal.close();
  const rows = h.read(file).trim().split('\n').map(JSON.parse);
  if (kind === 'hash') rows[1].event = 'TEARDOWN_COMPLETE';
  if (kind === 'link') {
    rows[1].previous = 'f'.repeat(64);
    const { sha256, ...payload } = rows[1]; rows[1].sha256 = digest(JSON.stringify(payload));
  }
  if (kind === 'sequence') {
    rows[1].seq = 7;
    const { sha256, ...payload } = rows[1]; rows[1].sha256 = digest(JSON.stringify(payload));
  }
  h.write(file, JSON.stringify(rows[0]) + '\n' + JSON.stringify(rows[1]) + (kind === 'torn' ? '' : '\n'));
  if (kind === 'custody') h.write(file, h.read(file), 0o600, 999);
  const code = kind === 'torn' ? 'ACT_JOURNAL_TORN' : kind === 'custody' ? 'ACT_JOURNAL_CUSTODY' : 'ACT_JOURNAL_INVALID';
  assert.throws(() => { const j = open(dir, h.boundary.fs, 'journal.jsonl', h.identity); j.close(); }, e => e.code === code, `B4_JOURNAL_${kind.toUpperCase()}`);
}
