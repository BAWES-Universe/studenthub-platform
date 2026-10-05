import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const IMAGE = 'ghcr.io/bawes-universe/studenthub-gateway';
export function selectArtifact(revision, inspect = (reference) => JSON.parse(execFileSync(
  'docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
))) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('revision must be a full lowercase 40-character SHA');
  const tag = `main-${revision}`;
  let manifest;
  try { manifest = inspect(`${IMAGE}:${tag}`); } catch { throw new Error(`immutable artifact absent or unreadable: ${tag}`); }
  const digest = manifest?.digest;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('immutable artifact has no valid sha256 digest');
  return { revision, image: IMAGE, tag, digest, pin: `${IMAGE}@${digest}`, coolifyTag: digest.replace(':', '-') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(selectArtifact(process.argv[2]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
