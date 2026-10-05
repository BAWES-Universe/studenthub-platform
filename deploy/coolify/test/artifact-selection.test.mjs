import assert from 'node:assert/strict';
import test from 'node:test';
import { IMAGE, selectArtifact } from '../select-artifact.mjs';
import { triggerSelected } from '../trigger-selected.mjs';

const revision = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const selection = selectArtifact(revision, () => ({ digest }));
const env = { COOLIFY_BASE: 'https://coolify.example.test', COOLIFY_TOKEN: 'fixture', COOLIFY_STUDENTHUB_GATEWAY_UUID: 'gateway' };
const application = { build_pack: 'dockerimage', docker_registry_image_name: IMAGE,
  docker_registry_image_tag: digest.replace(':', '-'), fqdn: 'https://staging.studenthub.co' };

test('selects full revision tag and immutable digest', () => {
  assert.deepEqual(selectArtifact(revision, (reference) => {
    assert.equal(reference, `${IMAGE}:main-${revision}`);
    return { digest };
  }), { revision, image: IMAGE, tag: `main-${revision}`, digest, pin: `${IMAGE}@${digest}`, coolifyTag: digest.replace(':', '-') });
});

test('absent immutable artifact fails closed', () => {
  assert.throws(() => selectArtifact(revision, () => { throw new Error('404'); }),
    /immutable artifact absent or unreadable/, 'ABSENT_ARTIFACT: missing immutable tag must fail without latest fallback');
});

test('mutable revision and malformed digest fail closed', () => {
  assert.throws(() => selectArtifact('main', () => assert.fail('registry must not be called')),
    /full lowercase 40-character SHA/, 'INVALID_REVISION: mutable refs must be rejected before registry access');
  assert.throws(() => selectArtifact(revision, () => ({ digest: 'latest' })),
    /no valid sha256 digest/, 'INVALID_DIGEST: malformed registry digest must not produce a pin');
});

test('deploy refuses latest, wrong digest, wrong image and non-staging target without POST', async () => {
  for (const override of [{ docker_registry_image_tag: 'latest' }, { docker_registry_image_tag: `sha256-${'c'.repeat(64)}` },
    { docker_registry_image_name: 'other/image' }, { fqdn: 'https://production.example.test' }, { build_pack: 'nixpacks' }]) {
    const methods = [];
    await assert.rejects(() => triggerSelected(selection, env, async (_url, options) => {
      methods.push(options.method);
      return Response.json({ ...application, ...override });
    }), /must already pin the selected digest/, 'UNPINNED_TARGET: mismatched application must refuse deployment');
    assert.deepEqual(methods, ['GET'], 'NO_POST: refused application must never receive a deployment request');
  }
});

test('verified digest deployment records Coolify deployment ID', async () => {
  const methods = [];
  const receipt = await triggerSelected(selection, env, async (url, options) => {
    methods.push(options.method);
    if (url.pathname === '/health') return Response.json({ status: 'ok', component: 'gateway', revision: revision });
    if (url.pathname === '/api/v1/deployments/deploy-1') return Response.json({ deployment_uuid: 'deploy-1', status: 'finished' });
    return Response.json(options.method === 'GET' ? { ...application, status: 'running:healthy' } : { deployments: [{ deployment_uuid: 'deploy-1' }] });
  });
  assert.deepEqual(methods, ['GET', 'POST', 'GET', 'GET', 'GET']);
  assert.deepEqual(receipt.deploymentUuids, ['deploy-1']);
  assert.equal(receipt.pin, selection.pin);
});

test('deploy HTTP failure and absent deployment ID fail closed', async () => {
  await assert.rejects(() => triggerSelected(selection, env, async () => new Response('', { status: 503 })),
    /HTTP 503/, 'HTTP_FAILURE: API failure must propagate');
  await assert.rejects(() => triggerSelected(selection, env, async (_url, options) => Response.json(options.method === 'GET' ? application : {})),
    /no deployment UUID/, 'MISSING_RECEIPT: trigger without deployment ID must fail');
});
