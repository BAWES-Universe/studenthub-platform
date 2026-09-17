// Historical bytes are mandatory fixtures, even when Git history is absent.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const fixtures = new URL('./fixtures/shu71-history/', import.meta.url);
const repo = new URL('../../../../', import.meta.url);
const fail = (code, detail) => { throw Object.assign(new Error(`${code}: ${detail}`), { code }); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export const controlRevisions = [
  '5e25c651254a72adbb46fa8f950df95248b640e9',
  'e9a68c156a0b8631b314d8d14c626ba31014a882',
  '0eeadd5f05abc8cd82968a855b2bff8cc137c65a',
];

// These are semantic prerequisites of the controls, not a provenance proof.
// Scope checks to executable cleanup code; comments cannot satisfy a check.
export function controlContent(revision, name, source) {
  if (!controlRevisions.includes(revision)) return; // synthetic Git-mechanism fixture
  const require = (condition, property) => {
    if (!condition) fail('SHU71_HISTORY_CONTROL_CONTENT', `${revision}/${name}: ${property}`);
  };
  const compact = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/\s+/g, '');
  if (name === 'shu71-journal.mjs') {
    const code = compact(source);
    require(code.includes("payload.seq===index&&payload.previous===previous&&sha256===digest(JSON.stringify(payload))"), 'JOURNAL_VALIDATES_CHAIN');
    require(code.includes("['gate','activation','workers','reload','evidence-broker'].includes(step)||step.startsWith('stop-')"), 'JOURNAL_REPEATS_PHYSICAL_EFFECTS');
    require(code.includes('awaitjournalEffect(journal,`teardown:${step}`,effect,repeat)'), 'JOURNAL_APPLIES_REPEAT');
    require(code.includes("if(step==='expiry-timer'&&failures.length)throwactivationError('ACT_CLEANUP_FAILED')"), 'JOURNAL_FAILURE_VETOES_RETIREMENT');
    return;
  }
  require(name === 'shu71-production.mjs', 'KNOWN_CONTROL_MODULE');
  const body = source.match(/async function cleanup\([^]*?\n  return Object\.freeze/ )?.[0];
  require(!!body, 'CLEANUP_BODY_PRESENT');
  const code = compact(body);
  const split = code.indexOf('consteffects=[');
  require(split >= 0, 'ORDERED_EFFECTS_PRESENT');
  const prefix = code.slice(0, split), effects = code.slice(split);
  require(effects.startsWith("consteffects=[['gate',()=>{for(constfileofGATES)"), 'GATE_FIRST_ORDINARY_EFFECT');
  require(effects.indexOf("['activation',()=>remove(ACTIVATION_FILE)]") > effects.indexOf("atomic(file,"), 'DISARM_BEFORE_CREDENTIAL_REMOVAL');
  require(!prefix.includes('remove(ACTIVATION_FILE)'), 'NO_CREDENTIAL_REVOCATION_IN_FAULT_FALLBACK');
  require(!prefix.includes('AUTOMATIC_TEARDOWN_RESERVED'), 'NO_RESERVATION_EVIDENCE_BINDING');
  if (revision === controlRevisions[0]) {
    require(!prefix.includes('automatic-teardown.json') && !prefix.includes('if(automatic)'), 'PARENT_NO_RESERVATION_BEFORE_DISARM');
    require(!prefix.includes('ACT_RETRY_BUDGET_UNAVAILABLE'), 'PARENT_NO_COUNTER_FAULT_FALLBACK');
  } else {
    require(prefix.includes('atomic(`${dir}/automatic-teardown.json`,JSON.stringify({attempts:attempts+1}))'), 'BLOCKED_RESERVATION_BEFORE_DISARM');
    if (revision === controlRevisions[1]) {
      require(prefix.includes("catch{return{ok:false,state:'HALT',code:'ACT_RETRY_BUDGET_UNAVAILABLE'"), 'R4_FAULT_RETURNS_WITHOUT_DISARM');
      require(!prefix.includes('for(constfileofGATES)'), 'R4_NO_FAULT_GATE_LOOP');
    } else {
      require(prefix.includes('for(constfileofGATES)') && prefix.includes("atomic(file,'[Service]\\nEnvironment=ENABLE_DISPATCH=false\\n'"), 'R5_FAULT_DISARMS_GATES_ONLY');
      require(code.includes('.settlement_started)returnrefusal;'), 'R5_COUNTER_BOOLEAN_SETTLEMENT_AUTHORITY');
    }
  }
}

export function historicalSource(revision, name) {
  const identity = `${revision}:.github/coordinator/service/${name}`;
  let manifest, bytes;
  try { manifest = JSON.parse(fs.readFileSync(new URL('sha256.json', fixtures), 'utf8')); }
  catch { fail('SHU71_HISTORY_MANIFEST', 'restore fixtures/shu71-history/sha256.json'); }
  const expected = manifest[revision]?.[name];
  if (!/^[a-f0-9]{64}$/.test(expected ?? ''))
    fail('SHU71_HISTORY_UNRESOLVED', `${identity}; vendor the historical bytes and record their SHA-256`);
  try { bytes = fs.readFileSync(new URL(`${revision}/${name}`, fixtures)); }
  catch { fail('SHU71_HISTORY_FIXTURE_MISSING', `${identity}; restore the checked-in historical fixture`); }
  if (digest(bytes) !== expected)
    fail('SHU71_HISTORY_DIGEST_MISMATCH', `${identity}; restore the historical bytes matching sha256.json`);

  controlContent(revision, name, bytes.toString('utf8'));

  const git = args => spawnSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
  const available = git(['cat-file', '-e', `${revision}^{commit}`]);
  if (available.error || available.signal || ![0, 1, 128].includes(available.status))
    fail('SHU71_HISTORY_GIT_CHECK', `${identity}; ensure Git can inspect the local object database`);
  if (available.status === 0) {
    const historical = git(['show', identity]);
    if (historical.status !== 0)
      fail('SHU71_HISTORY_SOURCE_UNRESOLVED', `${identity}; restore this revision's source object`);
    if (digest(historical.stdout) !== expected || !bytes.equals(historical.stdout))
      fail('SHU71_HISTORY_GIT_MISMATCH', `${identity}; fixture and manifest must match the historical Git bytes`);
    console.info(`SHU71_HISTORY_GIT_VERIFIED: ${identity}`);
  } else {
    console.info(`SHU71_HISTORY_GIT_UNAVAILABLE: ${identity}; provenance not cross-checked against Git; recorded digest and control-content guard only`);
  }
  return bytes.toString('utf8');
}
