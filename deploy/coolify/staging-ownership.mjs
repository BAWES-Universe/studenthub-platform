import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { IMAGE } from './select-artifact.mjs';

// What staging should run, worked out from live state alone (the `on-dev` label).
//
// GitHub keeps only the newest queued run in a concurrency group, so any run may be
// dropped. Nothing here therefore acts on the event that started a run. Each step
// reconciles the live state instead, so whichever run survives restores it:
// - `decide` settles the label: the same-repository PR labelled most recently owns
//   staging, every other holder (and any fork PR) loses the label. It names the
//   branch to build: the owner's, or main when nobody holds the label.
// - `resolve` (in the switch job, right before switching) reads the wanted commit
//   again and finds its `dev-<sha>` image. A run whose own build is stale switches
//   to the wanted commit's image when that exists, and does nothing when it does
//   not yet: the wanted commit's own run is still to come.
// - `confirm` rechecks the wanted commit right before the switch step.
export const LABEL = 'on-dev';
export const DEFAULT_BRANCH = 'main';

// holders: [{ number, labeledAt, headRef, crossRepository }] for open PRs carrying the label.
export function desired(holders) {
  const eligible = holders.filter((h) => !h.crossRepository);
  const owner = eligible.reduce((latest, h) => (!latest || h.labeledAt > latest.labeledAt
    || (h.labeledAt === latest.labeledAt && h.number > latest.number) ? h : latest), undefined);
  const release = holders.filter((h) => h !== owner).map((h) => ({ number: h.number, fork: h.crossRepository }));
  if (!owner) return { mode: 'free', pr: '', branch: DEFAULT_BRANCH, release };
  return { mode: 'pr', pr: String(owner.number), branch: owner.headRef, release };
}

function github(env) {
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 60_000 }).trim();
  const repo = env.GITHUB_REPOSITORY;
  return {
    holders: () => gh('pr', 'list', '--repo', repo, '--state', 'open', '--label', LABEL, '--limit', '100', '--json', 'number', '--jq', '.[].number')
      .split('\n').filter(Boolean).map(Number),
    holder: (number) => {
      const pr = JSON.parse(gh('pr', 'view', String(number), '--repo', repo, '--json', 'headRefName,isCrossRepository'));
      const labeled = gh('api', '--paginate', `repos/${repo}/issues/${number}/events`, '--jq', `.[] | select(.event == "labeled" and .label.name == "${LABEL}") | .created_at`)
        .split('\n').filter(Boolean);
      return { number, labeledAt: labeled.at(-1) ?? '', headRef: pr.headRefName, crossRepository: pr.isCrossRepository };
    },
    prHead: (pr) => gh('pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid', '--jq', '.headRefOid'),
    branchHead: (branch) => gh('api', `repos/${repo}/git/ref/heads/${branch}`, '--jq', '.object.sha'),
    release: ({ number, fork }, owner) => {
      gh('pr', 'edit', String(number), '--repo', repo, '--remove-label', LABEL);
      gh('pr', 'comment', String(number), '--repo', repo, '--body', fork
        ? `Pull requests from forks can't go on staging, so \`${LABEL}\` was removed.`
        : `Staging was taken over by #${owner}, so this PR is no longer on staging. Add \`${LABEL}\` again to put it back.`);
    },
    // The build pushes `dev-<sha>`; a missing tag means that build has not pushed yet.
    devDigest: (sha) => {
      try {
        return JSON.parse(execFileSync('docker', ['buildx', 'imagetools', 'inspect', `${IMAGE}:dev-${sha}`, '--format', '{{json .Manifest}}'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })).digest;
      } catch { return ''; }
    },
  };
}

const live = (api) => desired(api.holders().map((number) => api.holder(number)));
const headOf = (api, want) => (want.mode === 'pr' ? api.prHead(want.pr) : api.branchHead(want.branch));

export function runDecide(api) {
  const want = live(api);
  for (const holder of want.release) api.release(holder, want.pr);
  return want;
}

// What the switch job should put on staging now: the wanted commit and its image digest,
// or no digest when that commit's build has not pushed its image yet.
export function runResolve(api) {
  const want = live(api);
  const sha = headOf(api, want);
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error(`could not read the head of ${want.branch}`);
  return { ...want, sha, digest: api.devDigest(sha) };
}

export function runConfirm(api, sha) {
  return headOf(api, live(api)) === sha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2], env = process.env, api = github(env);
  const output = (values) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
  try {
    if (command === 'decide') {
      const want = runDecide(api);
      console.log(`Staging belongs to ${want.pr ? `#${want.pr}` : DEFAULT_BRANCH}; building ${want.branch}`);
      output({ branch: want.branch, pr: want.pr, mode: want.mode });
    } else if (command === 'resolve') {
      const want = runResolve(api);
      console.log(want.digest
        ? `Staging should run ${want.sha} (${want.pr ? `#${want.pr}` : DEFAULT_BRANCH})`
        : `${want.sha} has no image yet; its own run will switch staging`);
      output({ sha: want.sha, digest: want.digest, pr: want.pr });
    } else if (command === 'confirm') {
      const current = runConfirm(api, env.SHA);
      console.log(current ? `${env.SHA} is still wanted` : `${env.SHA} is no longer wanted; a newer run will switch staging`);
      output({ current: String(current) });
    } else throw new Error('usage: staging-ownership.mjs decide|resolve|confirm');
  } catch (error) {
    console.error(`::error::${error.message}; staging was not changed`);
    process.exitCode = 1;
  }
}
