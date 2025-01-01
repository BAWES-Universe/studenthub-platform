import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, assertPolicy, WORKSPACE_STATE_DIR } from '../units.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'shu-env-content-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const params = { workdir: root, supervisor: ['/usr/bin/true'], coordinator: ['/usr/bin/true'],
    writerLock: join(WORKSPACE_STATE_DIR, 'host-tick.lock'),
    supervisorEnvironmentFile: join(root, 'supervisor.env'), coordinatorEnvironmentFile: join(root, 'coordinator.env') };
  fs.writeFileSync(params.supervisorEnvironmentFile, `SHU_SUPERVISOR_SECRET=${'s'.repeat(32)}\n`, { mode: 0o600 });
  fs.writeFileSync(params.coordinatorEnvironmentFile, 'GITHUB_TOKEN=fixture-only\nLINEAR_API_TOKEN=fixture-only\n', { mode: 0o600 });
  return params;
}

const positives = [
  ['COMMAND', 'SHU_WORKER_LAUNCH_WRAPPER', '"placeholder command with spaces"'],
  ['SSH_COMMAND', 'SHU_PUSH_SSH_COMMAND', '"ssh placeholder command"'],
  ['DOUBLE_JSON', 'SHU_REVIEW_EXEC_WRAPPER_JSON', String.raw`"{\"k\":\"placeholder's value\"}"`],
  ['SINGLE_JSON', 'SHU_REVIEW_TEST_FILES_JSON', `'{"k":"placeholder value"}'`],
  ['DOUBLE_ESCAPES', 'PROBE', String.raw`"placeholder\\path\`suffix\q"`],
  ['SINGLE_LITERAL_SLASH', 'PROBE', String.raw`'placeholder\path'`],
  ['UNQUOTED_ESCAPE', 'PROBE', String.raw`placeholder\ path`],
  ['OUTER_WHITESPACE', 'PROBE', ' \t"placeholder value"\t '],
];
for (const [label, key, raw] of positives) test(`ENV_CONTENT_ACCEPT_${label}`, t => {
  const params = fixture(t);
  fs.appendFileSync(params.coordinatorEnvironmentFile, `${key}=${raw}\n`);
  // Boolean assertions ensure failures never include environment contents.
  let accepted = false;
  try { const units = render(params); assertPolicy(units, params); accepted = true; } catch {}
  assert.ok(accepted, `ENV_CONTENT_ACCEPT_${label}: ${key} must render and pass policy`);
});

const negatives = [
  ['EMPTY', ''], ['WHITESPACE', ' \t '], ['QUOTED_EMPTY', '""'], ['QUOTED_WHITESPACE', "'   '"],
  ['UNTERMINATED_DOUBLE', '"placeholder'], ['MISMATCHED', `"placeholder'`],
  ['TRAILING', '"placeholder"suffix'], ['INNER_DOUBLE', '"place"holder"'],
  ['INNER_SINGLE', `'{"k":"placeholder's value"}'`],
  ['DOLLAR', '$PLACEHOLDER'], ['BRACED_DOLLAR', '${PLACEHOLDER}'],
  ['CONTINUATION', 'placeholder\\\n# continuation'], ['DOUBLE_CONTINUATION', '"placeholder\\\n# continuation'],
  ['UNQUOTED_QUOTE', 'place"holder'], ['ESCAPED_CLOSING', '"placeholder\\"'],
];
for (const [label, raw] of negatives) test(`ENV_CONTENT_REFUSE_${label}`, t => {
  const params = fixture(t), units = render(params);
  fs.appendFileSync(params.coordinatorEnvironmentFile, `PROBE=${raw}\n`);
  for (const operation of [() => render(params), () => assertPolicy(units, params)]) {
    let refused = false;
    try { operation(); } catch (error) {
      refused = error.code === 'ERR_ASSERTION' && error.message.startsWith('SHU251_ENV_CONTENT:');
    }
    assert.ok(refused, `ENV_CONTENT_REFUSE_${label}: SHU251_ENV_CONTENT required for PROBE`);
  }
});

// Escapes must be decoded before the existing 32-byte effective-secret guard.
for (const [label, raw, accepted] of [
  ['DOUBLE_DECODE_SHORT', '"' + String.raw`\"`.repeat(16) + '"', false],
  ['DOUBLE_DECODE_BOUNDARY', '"' + String.raw`\"`.repeat(32) + '"', true],
  ['SINGLE_LITERAL_BOUNDARY', "'" + String.raw`\q`.repeat(16) + "'", true],
]) test(`ENV_CONTENT_EFFECTIVE_${label}`, t => {
  const params = fixture(t);
  fs.writeFileSync(params.supervisorEnvironmentFile, `SHU_SUPERVISOR_SECRET=${raw}\n`);
  let result = false;
  try { const units = render(params); assertPolicy(units, params); result = accepted; }
  catch (error) { result = !accepted && error.code === 'ERR_ASSERTION' && error.message.startsWith('SHU251_ENV_SUPERVISOR:'); }
  assert.ok(result, `ENV_CONTENT_EFFECTIVE_${label}: effective byte length required`);
});
