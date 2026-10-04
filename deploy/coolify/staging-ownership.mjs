import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DeploymentOutcome } from './trigger-selected.mjs';

// Who holds staging (the `on-dev` label) and whether a build may still take it.
// `decide` runs on every on-dev label, push or close event; `guard` runs right before
// a switch. GitHub may drop a queued decision when a newer one arrives, so `decide`
// never acts on its own event alone: it reconciles the live label state. The PR that
// took the label most recently owns staging, every other holder loses the label, and
// with no holder staging returns to main. The newest decision therefore always
// restores the whole intended state, whichever earlier ones were dropped.
export const LABEL = 'on-dev';
export const DEFAULT_BRANCH = 'main';
const skip = (reason) => ({ branch: '', pr: '', mode: '', remove: [], reason });

// holders: [{ number, labeledAt, headRef, crossRepository }] for open PRs carrying the label.
export function decide(event, holders) {
  if (event.name === 'workflow_dispatch') {
    if (holders.length) return skip(`#${holders.map((h) => h.number).join(', #')} holds ${LABEL}; remove the label first`);
    return { branch: event.inputBranch, pr: '', mode: 'manual', remove: [], reason: 'manual run' };
  }
  if (!holders.length) return { branch: DEFAULT_BRANCH, pr: '', mode: 'free', remove: [], reason: `${LABEL} is free` };
  const owner = holders.reduce((latest, h) => (h.labeledAt > latest.labeledAt || (h.labeledAt === latest.labeledAt && h.number > latest.number) ? h : latest));
  const remove = holders.filter((h) => h !== owner).map((h) => h.number);
  if (owner.crossRepository) return { ...skip(`#${owner.number} is from a fork; staging builds only this repository's branches`), remove, owner: owner.number };
  return { branch: owner.headRef, pr: String(owner.number), mode: 'pr', remove, owner: owner.number, reason: `#${owner.number} holds ${LABEL}` };
}

// Staging may change only if the run still owns it exclusively and its build is the
// branch's current head, so an older build of the same PR never replaces a newer one.
export function guard({ mode, pr, holders, head, sha }) {
  const fail = (detail) => { throw new DeploymentOutcome('PRECONDITION_NOT_MET', detail); };
  if (mode === 'pr') {
    if (holders.length !== 1 || holders[0] !== Number(pr)) fail(`expected only #${pr} to hold ${LABEL}, found [${holders.join(', ')}]`);
  } else if (mode === 'free' || mode === 'manual') {
    if (holders.length) fail(`#${holders.join(', #')} holds ${LABEL}`);
  } else fail(`unknown mode '${mode}'`);
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || head !== sha) fail(`build ${sha} is not the branch head ${head}`);
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
    release: (other, taker) => {
      gh('pr', 'edit', String(other), '--repo', repo, '--remove-label', LABEL);
      gh('pr', 'comment', String(other), '--repo', repo, '--body',
        `Staging was taken over by #${taker}, so this PR is no longer on staging. Add \`${LABEL}\` again to put it back.`);
    },
  };
}

export function runDecide(env, api = github(env)) {
  const event = { name: env.EVENT, inputBranch: env.INPUT_BRANCH };
  const result = decide(event, api.holders().map((number) => api.holder(number)));
  for (const other of result.remove) api.release(other, result.owner);
  return result;
}

export function runGuard(env, api = github(env)) {
  if (env.MODE !== 'pr' && (!/^[A-Za-z0-9._/-]+$/.test(env.BRANCH ?? '') || env.BRANCH.includes('..'))) {
    throw new DeploymentOutcome('PRECONDITION_NOT_MET', 'invalid branch name');
  }
  const head = env.MODE === 'pr' ? api.prHead(env.PR) : api.branchHead(env.BRANCH);
  guard({ mode: env.MODE, pr: env.PR, holders: api.holders(), head, sha: env.SHA });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  try {
    if (command === 'decide') {
      const result = runDecide(process.env);
      console.log(`Decision: ${result.reason}; branch='${result.branch || 'none'}' mode='${result.mode || 'none'}'`);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `branch=${result.branch}\npr=${result.pr}\nmode=${result.mode}\n`);
    } else if (command === 'guard') {
      runGuard(process.env);
      console.log('Staging is still this run\'s to change');
    } else throw new Error(`usage: staging-ownership.mjs decide|guard`);
  } catch (error) {
    console.error(`::error::${error.message}; staging was not changed`);
    process.exitCode = 1;
  }
}
