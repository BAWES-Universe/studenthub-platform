import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { IMAGE } from './select-artifact.mjs';

export function assertSelectedApplication(application, selection) {
  if (selection.image !== IMAGE || !/^sha256:[a-f0-9]{64}$/.test(selection.digest ?? '')
    || selection.pin !== `${IMAGE}@${selection.digest}`
    || application.build_pack !== 'dockerimage'
    || application.docker_registry_image_name !== IMAGE
    || application.docker_registry_image_tag !== selection.digest.replace(':', '-')
    || application.fqdn !== 'https://staging.studenthub.co') {
    throw new Error('staging application must already pin the selected digest');
  }
}

export async function triggerSelected(selection, env = process.env, request = fetch) {
  for (const key of ['COOLIFY_BASE', 'COOLIFY_TOKEN', 'COOLIFY_STUDENTHUB_GATEWAY_UUID']) {
    if (!env[key]) throw new Error(`missing ${key}`);
  }
  const base = new URL(env.COOLIFY_BASE);
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Coolify requires an HTTPS base URL without credentials');
  const uuid = encodeURIComponent(env.COOLIFY_STUDENTHUB_GATEWAY_UUID);
  const call = async (path, method) => {
    const response = await request(new URL(path, base), {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${env.COOLIFY_TOKEN}`, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Coolify ${method} failed (HTTP ${response.status})`);
    return response.json();
  };
  assertSelectedApplication(await call(`/api/v1/applications/${uuid}`, 'GET'), selection);
  const result = await call(`/api/v1/deploy?uuid=${uuid}`, 'POST');
  if (!Array.isArray(result.deployments) || !result.deployments.length
      || result.deployments.some((item) => !item.deployment_uuid)) throw new Error('Coolify returned no deployment UUID');
  return { ...selection, applicationUuid: env.COOLIFY_STUDENTHUB_GATEWAY_UUID,
    deploymentUuids: result.deployments.map((item) => item.deployment_uuid) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const receipt = await triggerSelected(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    writeFileSync('deployment-receipt.json', `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  } catch { console.error('selected deployment failed; inspect the recorded selection and Coolify deployment history'); process.exitCode = 1; }
}
