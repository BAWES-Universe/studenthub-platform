import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DeploymentOutcome } from './trigger-selected.mjs';

// Who holds staging (the `on-dev` label) and whether a build may still take it.
// `decide` runs when a label, push or close event arrives; `guard` runs right
// before a switch. Both read the live label holders, never the event payload alone,
// so a late or out-of-order event cannot take staging from the current holder.
export const LABEL = 'on-dev';
export const DEFAULT_BRANCH = 'main';
const skip = (reason) => ({ branch: '', pr: '', mode: '', remove: [], reason });

export function decide(event, holders) {
  const { name, action, label, pr, headRef, hadLabel, inputBranch } = event;
  const others = holders.filter((n) => n !== pr);
  if (name === 'workflow_dispatch') {
    if (holders.length) return skip(`#${holders.join(', #')} holds ${LABEL}; remove the label first`);
    return { branch: inputBranch, pr: '', mode: 'manual', remove: [], reason: 'manual run' };
  }
  if (action === 'labeled' && label === LABEL) {
    // A late event for a PR that already lost the label must not take it back.
    if (!holders.includes(pr)) return skip(`#${pr} no longer holds ${LABEL}`);
    return { branch: headRef, pr: String(pr), mode: 'pr', remove: others, reason: `#${pr} took ${LABEL}` };
  }
  if (action === 'synchronize') {
    if (!holders.includes(pr)) return skip(`#${pr} does not hold ${LABEL}`);
    return { branch: headRef, pr: String(pr), mode: 'pr', remove: [], reason: `#${pr} was updated` };
  }
  if ((action === 'unlabeled' && label === LABEL) || (action === 'closed' && hadLabel)) {
    if (others.length) return skip(`#${others.join(', #')} holds ${LABEL}`);
    return { branch: DEFAULT_BRANCH, pr: '', mode: 'free', remove: [], reason: `${LABEL} is free` };
  }
  return skip('event does not change staging');
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
  const pr = env.PR ? Number(env.PR) : undefined;
  const result = decide({
    name: env.EVENT, action: env.ACTION, label: env.EVENT_LABEL, pr, headRef: env.HEAD_REF,
    hadLabel: env.HAD_LABEL === 'true', inputBranch: env.INPUT_BRANCH,
  }, api.holders());
  for (const other of result.remove) api.release(other, pr);
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
