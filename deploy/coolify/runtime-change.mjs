import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function affectsRuntime(path) {
  if (path.startsWith('.github/') || /(^|\/)(docs?|test|tests)\//.test(path)
    || /\.(md|mdx|test\.[cm]?[jt]s)$/.test(path)) return false;
  if (path.startsWith('deploy/coolify/')) return ['gateway-entrypoint.sh', 'preflight.mjs', 'assert-image-content.mjs', 'stage-workspaces.mjs', 'prune-workspace-links.mjs'].includes(path.slice('deploy/coolify/'.length));
  return /^(apps\/|packages\/|tools\/)/.test(path)
    || ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json'].includes(path);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { BEFORE_SHA: before, GITHUB_SHA: after } = process.env;
  if (![before, after].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? '')) || /^0+$/.test(before)) throw new Error('runtime scope requires two existing commit SHAs');
  const changed = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', before, after], { encoding: 'utf8' }).split('\0').filter(Boolean).some(affectsRuntime);
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
