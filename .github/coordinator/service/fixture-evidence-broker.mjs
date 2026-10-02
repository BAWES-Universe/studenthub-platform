// A separate service owns API credentials. Only the two fixed read operations
// below cross its local socket; no URL, query, credential, or command is supplied
// by callers. Responses contain public fixture evidence only.
import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readTwoFixtureEvidenceAsync, readFixtureAncestryAsync } from '../two-fixture-evidence.mjs';
import { EVIDENCE_SOCKET } from './credential-delivery.mjs';
const config = Object.freeze({ pilot_repo: 'BAWES-Universe/studenthub-platform' });
// SHU-71 run 3: reads run asynchronously. A synchronous read blocked the one
// event loop, so with two lanes live the coordinator's and both workers' reads
// queued behind each other past the client's timeout, and the coordinator saw
// no evidence at all.
export async function fixtureEvidenceRequest(request, env, run) {
  if (JSON.stringify(request) === '{"operation":"evidence"}') return readTwoFixtureEvidenceAsync(config, env, run);
  if (request?.operation === 'ancestry' && Object.keys(request).sort().join() === 'base,head,operation'
      && /^[a-f0-9]{40}$/.test(request.base) && /^[a-f0-9]{40}$/.test(request.head)) {
    return { ancestor: await readFixtureAncestryAsync(config, env, request.base, request.head, run) };
  }
  return { code: 'ACT_EVIDENCE_REQUEST_INVALID' };
}
// One connection, one bounded request. Each read runs on its own, so a slow read
// never holds another caller's answer.
export function evidenceConnection(env, run) {
  return socket => {
    let input = ''; socket.setTimeout(15000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > 512) return socket.destroy();
      if (!input.endsWith('\n')) return;
      socket.pause();
      Promise.resolve().then(() => fixtureEvidenceRequest(JSON.parse(input), env, run))
        .then(result => socket.end(JSON.stringify(result) + '\n'), () => socket.end('{"code":"ACT_EVIDENCE_UNAVAILABLE"}\n'));
    });
  };
}
export function startEvidenceBroker(env = process.env) {
  const server = net.createServer(evidenceConnection(env));
  server.listen(EVIDENCE_SOCKET, () => fs.chmodSync(EVIDENCE_SOCKET, 0o660));
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) startEvidenceBroker();
