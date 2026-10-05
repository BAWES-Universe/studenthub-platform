import { supervisorTransportSecret } from "./credential-delivery.mjs";
// Read-only acceptance client for a later approved window. Never construct a
// SupervisorStore here: its constructor changes directory permissions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { signedSupervisorRequest, submitToSupervisor } from '../supervisor.mjs';
import { assertStatusShape } from './residual-validation.mjs';

export async function checkStatus({ stateDir, socketPath, secret, order }) {
  const attemptId = order.attempt_id;
  assert.match(attemptId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const file = tree => join(stateDir, tree, `${attemptId}.json`);
  const store = {
    hasLaunch: () => fs.existsSync(file('launches')),
    readLaunch: () => JSON.parse(fs.readFileSync(file('launches'), 'utf8')),
    readOrder: () => JSON.parse(fs.readFileSync(file('orders'), 'utf8')).order,
  };
  const status = await submitToSupervisor({ socketPath, request: signedSupervisorRequest(order, secret, 'status') });
  assertStatusShape(status, { store, attemptId });
  assert.equal(status.ok, true, 'SHU251_STATUS_AVAILABLE: authenticated status must be available');
  return status;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const order = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  console.log(JSON.stringify(await checkStatus({ stateDir: process.env.SHU_SUPERVISOR_STATE_DIR,
    socketPath: process.env.SHU_SUPERVISOR_SOCKET, secret: supervisorTransportSecret(process.env), order }), null, 2));
}
