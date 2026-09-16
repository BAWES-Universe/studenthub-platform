import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { supervisorTransportSecret, supervisorChildEnvironment, ACTIVATION_FILE } from '../credential-delivery.mjs';
import { fixtureEvidenceRequest } from '../fixture-evidence-broker.mjs';
import { readTwoFixtureEvidence, readFixtureAncestry } from '../../two-fixture-evidence.mjs';
import { serviceParameters } from '../units.mjs';
import { renderEvidenceBroker } from '../shu71-production.mjs';

test('B2 credential: transport consumes only fixed systemd credential and never exports it', () => {
  const env = { CREDENTIALS_DIRECTORY: '/run/credentials/shu-coordinator.service' };
  assert.equal(supervisorTransportSecret(env, file => {
    assert.equal(file, '/run/credentials/shu-coordinator.service/supervisor-transport');
    return `SHU_SUPERVISOR_SECRET=${'x'.repeat(32)}\n`;
  }), 'x'.repeat(32));
  assert.deepEqual(env, { CREDENTIALS_DIRECTORY: '/run/credentials/shu-coordinator.service' });
  for (const input of ['', 'SHU_SUPERVISOR_SECRET=short', `SHU_SUPERVISOR_SECRET=${'x'.repeat(32)}\nGITHUB_TOKEN=poison`]) {
    assert.throws(() => supervisorTransportSecret(env, () => input), /ACT_CREDENTIAL_UNAVAILABLE/);
  }
  assert.throws(() => supervisorTransportSecret({ CREDENTIALS_DIRECTORY: '/tmp/foreign' }, () => assert.fail('no foreign read')), /ACT_CREDENTIAL_UNAVAILABLE/);
});

test('B2 credential: supervisor children receive no transport or API secret', () => {
  const child = supervisorChildEnvironment({ PATH: '/usr/bin', SHU_SUPERVISOR_SECRET: 'secret', GITHUB_TOKEN: 'github',
    GH_TOKEN: 'github', LINEAR_API_TOKEN: 'linear', CREDENTIALS_DIRECTORY: '/private', SHU71_EVIDENCE_BROKER: 'true' });
  assert.deepEqual(child, { PATH: '/usr/bin', SHU71_EVIDENCE_BROKER: 'true' });
});

test('B2 rendered coordinator carries exact activation argv; broker identity and credential scope are literal', () => {
  const p = serviceParameters({ workdir: '/reviewed/repo', node: '/usr/bin/node' });
  assert.deepEqual(p.coordinator, ['/usr/bin/node', '/reviewed/repo/.github/coordinator/service/coordinator-tick.mjs', '--activation', ACTIVATION_FILE]);
  const unit = renderEvidenceBroker();
  assert.equal(unit, '[Unit]\nDescription=SHU71 bounded fixture evidence\n[Service]\nUser=996\nGroup=999\nEnvironmentFile=/srv/shu/coordinator.env\nRuntimeDirectory=shu71-evidence\nRuntimeDirectoryMode=0750\nUMask=0007\nExecStart=/usr/bin/node /usr/local/lib/shu71/coordinator/service/fixture-evidence-broker.mjs\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=true\nPrivateTmp=true\nRestart=on-failure\n');
  assert.match(fs.readFileSync(new URL('../shu-coordinator.service.in', import.meta.url), 'utf8'), /^LoadCredential=supervisor-transport:@SUPERVISOR_ENVIRONMENT_FILE@$/m);
  assert.match(fs.readFileSync(new URL('../shu-supervisor.service.in', import.meta.url), 'utf8'), /^Environment=SHU71_EVIDENCE_BROKER=true$/m);
});

test('B2 broker: arbitrary queries, URLs and command input are refused before credentials are used', () => {
  for (const input of [{ operation: 'write' }, { operation: 'evidence', url: 'https://evil' }, { operation: 'ancestry', base: 'x', head: 'y' }]) {
    assert.deepEqual(fixtureEvidenceRequest(input, {}, () => assert.fail('no command')), { code: 'ACT_EVIDENCE_REQUEST_INVALID' });
  }
});

test('B2 broker: actual child-side wiring sends no API tokens, env secrets or shell/eval source', () => {
  const env = { SHU71_EVIDENCE_BROKER: 'true', GITHUB_TOKEN: 'poison', LINEAR_API_TOKEN: 'poison' };
  const run = (file, args, opts) => {
    assert.equal(args.length, 1); assert.ok(args[0].endsWith('/service/fixture-evidence-client.mjs'));
    assert.deepEqual(opts.env, { PATH: '/usr/bin:/bin' });
    assert.doesNotMatch(JSON.stringify({ args, opts }), /poison/);
    const req = JSON.parse(opts.input);
    return JSON.stringify(req.operation === 'evidence' ? { heads: { fixed: 'a' }, issues: [{ id: 'SHU-140' }] } : { ancestor: true });
  };
  assert.equal(readTwoFixtureEvidence({}, env, run).heads.fixed, 'a');
  assert.equal(readFixtureAncestry({}, env, 'a'.repeat(40), 'b'.repeat(40), run), true);
});

test('B2 coordinator tick keeps Phase-A disabled ticks runnable and binds Phase-B argv', async () => {
  const { coordinatorTickArgs } = await import('../coordinator-tick.mjs');
  assert.deepEqual(coordinatorTickArgs(['--activation', ACTIVATION_FILE], { ENABLE_DISPATCH: 'false' }), []);
  assert.deepEqual(coordinatorTickArgs(['--activation', ACTIVATION_FILE], { ENABLE_DISPATCH: 'true' }), ['--activation', ACTIVATION_FILE]);
  assert.throws(() => coordinatorTickArgs(['--activation', '/tmp/foreign'], { ENABLE_DISPATCH: 'true' }), /ACT_ACTIVATION_PATH/);
});
