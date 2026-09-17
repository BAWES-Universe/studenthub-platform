// A separate service owns API credentials. Only the two fixed read operations
// below cross its local socket; no URL, query, credential, or command is supplied
// by callers. Responses contain public fixture evidence only.
import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readTwoFixtureEvidence, readFixtureAncestry } from '../two-fixture-evidence.mjs';
import { EVIDENCE_SOCKET } from './credential-delivery.mjs';
const config = Object.freeze({ pilot_repo: 'BAWES-Universe/studenthub-platform' });
export function fixtureEvidenceRequest(request, env, run) {
  if (JSON.stringify(request) === '{"operation":"evidence"}') return readTwoFixtureEvidence(config, env, run);
  if (request?.operation === 'ancestry' && Object.keys(request).sort().join() === 'base,head,operation'
      && /^[a-f0-9]{40}$/.test(request.base) && /^[a-f0-9]{40}$/.test(request.head)) {
    return { ancestor: readFixtureAncestry(config, env, request.base, request.head, run) };
  }
  return { code: 'ACT_EVIDENCE_REQUEST_INVALID' };
}
export function startEvidenceBroker(env = process.env) {
  const server = net.createServer(socket => {
    let input = ''; socket.setTimeout(15000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > 512) return socket.destroy();
      if (!input.endsWith('\n')) return;
      socket.pause();
      try { socket.end(JSON.stringify(fixtureEvidenceRequest(JSON.parse(input), env)) + '\n'); }
      catch { socket.end('{"code":"ACT_EVIDENCE_UNAVAILABLE"}\n'); }
    });
  });
  server.listen(EVIDENCE_SOCKET, () => fs.chmodSync(EVIDENCE_SOCKET, 0o660));
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) startEvidenceBroker();
