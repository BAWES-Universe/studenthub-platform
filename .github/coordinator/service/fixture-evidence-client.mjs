import net from 'node:net';
import { EVIDENCE_SOCKET } from './credential-delivery.mjs';
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 512) process.exit(1);
}
const socket = net.createConnection(EVIDENCE_SOCKET);
socket.setTimeout(14000, () => socket.destroy(new Error('timeout')));
socket.on('error', () => process.exit(1));
socket.on('connect', () => socket.write(input + '\n'));
let output = '';
socket.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 65536) socket.destroy(new Error('size')); });
socket.on('end', () => { process.stdout.write(output); });
