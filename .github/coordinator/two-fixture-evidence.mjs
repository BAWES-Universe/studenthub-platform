// Synchronous read-only evidence for the existing synchronous authorization API.
// The helper performs bounded API reads, never executes a work order or writes.
import { execFileSync } from 'node:child_process';

const READ_EVIDENCE = `
const input = JSON.parse(await new Promise(resolve => {
  let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => text += chunk);
  process.stdin.on('end', () => resolve(text));
}));
const read = async (url, options) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('evidence unavailable');
  return response.json();
};
const ids = ['SHU-140', 'SHU-254'];
const heads = {};
const issues = [];
await Promise.all(ids.map(async id => {
  const branch = 'coordinator/' + id;
  const head = await read('https://api.github.com/repos/' + input.repo + '/git/ref/heads/' + encodeURIComponent(branch), {
    headers: { Authorization: 'Bearer ' + input.githubToken, Accept: 'application/vnd.github+json' }
  });
  heads[branch] = head.object?.sha;
  const result = await read('https://api.linear.app/graphql', {
    method: 'POST', headers: { Authorization: input.linearToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query ActivationFixture($id: String!) { issue(id: $id) { id identifier } }', variables: { id } })
  });
  if (result.errors || result.data?.issue?.identifier !== id || !result.data.issue.id) throw new Error('fixture unresolved');
  issues.push({ id, linearId: result.data.issue.id });
}));
process.stdout.write(JSON.stringify({ heads, issues }));
`;

export function readTwoFixtureEvidence(config, env, run = execFileSync) {
  if (!env.GITHUB_TOKEN || !env.LINEAR_API_TOKEN || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.pilot_repo ?? '')) return { heads: {}, issues: [] };
  try {
    return JSON.parse(run(process.execPath, ['--input-type=module', '-e', READ_EVIDENCE], {
      // Credentials go over stdin, never process arguments or diagnostic output.
      input: JSON.stringify({ repo: config.pilot_repo, githubToken: env.GITHUB_TOKEN, linearToken: env.LINEAR_API_TOKEN }),
      env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 12000, maxBuffer: 65536,
      stdio: ['pipe', 'pipe', 'ignore'],
    }));
  } catch { return { heads: {}, issues: [] }; }
}

// Exact commit comparison from the configured repository. Unknown/missing API
// evidence never substitutes for ancestry. Credentials remain on stdin.
export function readFixtureAncestry(config, env, base, head, run = execFileSync) {
  if (!env.GITHUB_TOKEN || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.pilot_repo ?? '') ||
      !/^[0-9a-f]{40}$/.test(base ?? '') || !/^[0-9a-f]{40}$/.test(head ?? '') || base === head) return false;
  try {
    return run(process.execPath, ['--input-type=module', '-e', `
      let text = ''; for await (const chunk of process.stdin) text += chunk;
      const input = JSON.parse(text);
      const response = await fetch('https://api.github.com/repos/' + input.repo + '/compare/' + input.base + '...' + input.head,
        { headers: { Authorization: 'Bearer ' + input.token, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('comparison unavailable');
      const result = await response.json();
      process.stdout.write(String(result.status === 'ahead' && result.merge_base_commit?.sha === input.base));
    `], { input: JSON.stringify({ repo: config.pilot_repo, token: env.GITHUB_TOKEN, base, head }),
      env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10000, maxBuffer: 1024,
      stdio: ['pipe', 'pipe', 'ignore'] }).trim() === 'true';
  } catch { return false; }
}
