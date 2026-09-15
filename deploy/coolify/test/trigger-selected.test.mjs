import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnostic, triggerSelected } from '../trigger-selected.mjs';
import { IMAGE, selectArtifact } from '../select-artifact.mjs';

const selection = selectArtifact('a'.repeat(40), () => ({ digest: `sha256:${'b'.repeat(64)}` }));
const env = { COOLIFY_BASE: 'https://coolify.example.test', COOLIFY_TOKEN: 'fixture-secret', COOLIFY_STUDENTHUB_GATEWAY_UUID: 'gateway' };
const application = { build_pack: 'dockerimage', docker_registry_image_name: IMAGE,
  docker_registry_image_tag: selection.coolifyTag, fqdn: 'https://staging.studenthub.co', status: 'running:healthy' };
function stub(overrides = {}) {
  const calls = [];
  let time = 0;
  let polls = 0;
  const request = async (url, options) => {
    calls.push(`${options.method} ${url.pathname}`);
    assert.equal(url.origin === 'https://coolify.example.test' || url.origin === 'https://staging.studenthub.co', true);
    if (url.pathname === '/health') {
      assert.equal(options.headers.Authorization, undefined, 'TRIGGER_NO_TOKEN_LEAK');
      return Response.json(overrides.health ?? { status: 'ok', component: 'gateway', revision: selection.revision });
    }
    if (url.pathname === '/api/v1/applications/gateway') return Response.json({ ...application, ...overrides.app });
    if (url.pathname === '/api/v1/deploy') {
      if (overrides.lost) throw new Error('fixture-secret');
      if (overrides.http) return new Response('fixture-secret', { status: overrides.http });
      if (overrides.malformed) return new Response('fixture-secret');
      return Response.json(overrides.receipt ?? { deployments: [{ deployment_uuid: 'deploy-1', resource_uuid: 'gateway' }] });
    }
    assert.equal(url.pathname, '/api/v1/deployments/deploy-1', 'TRIGGER_CORRECT_POLL_ENDPOINT');
    polls++;
    if (overrides.missing) return new Response('', { status: 404 });
    return Response.json(overrides.deployment ?? { deployment_uuid: 'deploy-1', status: overrides.pending && polls === 1 ? 'queued' : 'finished' });
  };
  return { calls, run: () => triggerSelected(selection, env, request,
    { timeoutMs: 20, intervalMs: 10, now: () => time, sleep: async (ms) => { time += ms; } }) };
}
async function expectCode(fixture, code, name) {
  let actual;
  try { await fixture.run(); } catch (error) { actual = error; }
  assert.equal(actual?.code, code, name);
  assert.match(diagnostic(actual), new RegExp(`^${code}:`), name);
  assert.doesNotMatch(diagnostic(actual), /fixture-secret|selected deployment failed/, 'TRIGGER_SAFE_DIAGNOSTIC');
}

test('trigger precondition latest creates no deployment', async () => {
  const fixture = stub({ app: { docker_registry_image_tag: 'latest' } });
  await expectCode(fixture, 'PRECONDITION_NOT_MET', 'TRIGGER_PRECONDITION_TYPED');
  assert.deepEqual(fixture.calls, ['GET /api/v1/applications/gateway'], 'TRIGGER_PRECONDITION_NO_POST');
});
test('trigger explicit HTTP rejection is typed', async () => {
  for (const http of [400, 401, 403, 404, 405, 422, 429]) {
    await expectCode(stub({ http }), 'TRIGGER_REJECTED', 'TRIGGER_REJECTION_TYPED');
  }
});
test('trigger no deployment receipt is unknown not failed', async () => {
  for (const receipt of [{}, { deployments: [] }, { deployments: [{}] }, { deployments: [{ deployment_uuid: 'deploy-1', resource_uuid: 'foreign' }] }]) {
    await expectCode(stub({ receipt }), 'DEPLOYMENT_UNKNOWN', 'TRIGGER_NO_FALSE_FAILURE');
  }
});
test('trigger real terminal failure is detected', async () => {
  for (const status of ['failed', 'cancelled', 'cancelled-by-user']) {
    await expectCode(stub({ deployment: { deployment_uuid: 'deploy-1', status } }), 'DEPLOYMENT_FAILED', 'TRIGGER_REAL_FAILURE_DETECTED');
  }
});
test('trigger UUID receipt waits for finished and healthy selected revision', async () => {
  const fixture = stub({ pending: true });
  assert.equal((await fixture.run()).outcome, 'DEPLOYMENT_SUCCEEDED', 'TRIGGER_VERIFIED_SUCCESS');
  assert.equal(fixture.calls.filter((call) => call === 'GET /api/v1/deployments/deploy-1').length, 2, 'TRIGGER_POLLS_RECEIPT_UUID');
  assert.equal(fixture.calls.filter((call) => call.startsWith('POST')).length, 1, 'TRIGGER_SINGLE_POST');
});
test('trigger missing deployment and wrong UUID cannot prove failure', async () => {
  for (const overrides of [{ missing: true }, { deployment: [] }, { deployment: { deployment_uuid: 'old', status: 'failed' } },
    { deployment: { deployment_uuid: 'deploy-1', status: 'surprise' } }]) {
    await expectCode(stub(overrides), 'DEPLOYMENT_UNKNOWN', 'TRIGGER_UNVERIFIABLE_TYPED');
  }
});
test('trigger timeout and unhealthy or stale revision remain unknown', async () => {
  for (const overrides of [{ deployment: { deployment_uuid: 'deploy-1', status: 'in_progress' } },
    { app: { status: 'running:unhealthy' } }, { health: { status: 'ok', component: 'gateway', revision: 'c'.repeat(40) } }]) {
    await expectCode(stub(overrides), 'DEPLOYMENT_UNKNOWN', 'TRIGGER_HEALTH_REQUIRED');
  }
});
test('trigger ambiguous response never retries POST or leaks secrets', async () => {
  for (const overrides of [{ lost: true }, { http: 503 }, { malformed: true }]) {
    const fixture = stub(overrides);
    await expectCode(fixture, 'DEPLOYMENT_UNKNOWN', 'TRIGGER_AMBIGUOUS_TYPED');
    assert.equal(fixture.calls.filter((call) => call.startsWith('POST')).length, 1, 'TRIGGER_SINGLE_POST');
  }
});
test('trigger invalid local configuration is a precondition', async () => {
  for (const config of [{}, { ...env, COOLIFY_BASE: 'invalid' }, { ...env, COOLIFY_BASE: 'http://example.test' }]) {
    await expectCode({ run: () => triggerSelected(selection, config, () => assert.fail('no network')) }, 'PRECONDITION_NOT_MET', 'TRIGGER_CONFIG_TYPED');
  }
  assert.equal(diagnostic(new Error('fixture-secret')), 'DEPLOYMENT_UNKNOWN: selection could not be read or receipt could not be recorded');
});
