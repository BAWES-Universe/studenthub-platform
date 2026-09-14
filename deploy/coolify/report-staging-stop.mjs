import { execFileSync } from 'node:child_process';
import { FREEZE_TITLE } from './automatic-staging.mjs';
// Future Actions failure notification; never invoked by local verification.
try {
  const env = process.env;
  if (env.GITHUB_REPOSITORY !== 'BAWES-Universe/studenthub-platform' || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main') throw Error();
  const endpoint = `repos/${env.GITHUB_REPOSITORY}/issues`;
  const gh = (args) => JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }));
  const issues = gh(['--paginate', '--slurp', `${endpoint}?state=open&per_page=100`]).flat();
  const existing = issues.find((issue) => issue.title === FREEZE_TITLE);
  const outcome = ['PRECONDITION_NOT_MET', 'TRIGGER_REJECTED', 'DEPLOYMENT_FAILED', 'DEPLOYMENT_UNKNOWN'].includes(env.OUTCOME) ? env.OUTCOME : 'PREDEPLOY_STOPPED';
  const body = `Staging automation stopped: ${outcome}. This is not evidence of a failed deployment unless a deployment receipt confirms failure. Before-trigger failures leave the running artifact unchanged; after-trigger recovery is recorded in this issue. Freeze retained for owner review.\nRun: https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  gh(existing ? [`${endpoint}/${existing.number}/comments`, '-X', 'POST', '-f', `body=${body}`] : [endpoint, '-X', 'POST', '-f', `title=${FREEZE_TITLE}`, '-f', `body=${body}`]);
} catch { console.error('staging freeze/notification delivery could not be confirmed'); process.exitCode = 1; }
