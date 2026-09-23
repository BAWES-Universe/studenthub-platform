// THE MEASUREMENT JOB HOLDS `contents: read` AND NOTHING ELSE, AND THAT IS CHECKED RATHER THAN WRITTEN DOWN.
//
// The job that invokes candidate code is the job an escape would land in. What makes the escape worth nothing
// is that this job cannot sign, cannot write to this repository, and cannot mint an OIDC token - so even a
// full container escape reaches a process holding a read-only token. That is a property of the workflow, and
// a workflow is a file somebody edits, so it is READ BACK HERE out of the authority checkout before any
// candidate code runs, and the run refuses if the job has been given any write scope.
//
// TWO READINGS, because each catches what the other cannot:
//
//   THE TEXT. The job's own `permissions:` block in the authority's workflow file. This catches the edit -
//   somebody adding `packages: write` to the measurement job - at the first measurement rather than at the
//   next review.
//   THE RUNTIME. `ACTIONS_ID_TOKEN_REQUEST_URL` is how GitHub hands a job the ability to mint an OIDC token,
//   and it is present in the environment exactly when `id-token: write` is granted. This catches the case the
//   text cannot: a scope granted somewhere other than this block - a reusable-workflow caller, an
//   organisation default, a future GitHub behaviour - and it catches it by observing the job this process is
//   actually running in rather than by reading a file about it.
//
// Neither reading is the sandbox. The sandbox is what stops the candidate reaching this job at all; this is
// what makes reaching it worthless.
import fs from 'node:fs';

export function jobScopes({ workflowText, jobId }) {
  const lines = workflowText.split('\n');
  const at = lines.findIndex(line => new RegExp(`^  ${jobId}:\\s*$`).test(line));
  if (at < 0) throw new Error(`the authority's own workflow has no job ${JSON.stringify(jobId)}, so this run cannot read the scopes it holds`);
  const end = lines.findIndex((line, index) => index > at && /^  \S/.test(line));
  const body = lines.slice(at, end < 0 ? lines.length : end);
  const block = body.findIndex(line => /^    permissions:\s*$/.test(line));
  // AN ABSENT BLOCK IS A REFUSAL, NOT A DEFAULT. A job with no `permissions:` inherits the workflow's, and
  // what the workflow's will be after the next edit is not something this process can read out of the job.
  if (block < 0) throw new Error(`the ${jobId} job declares no permissions block, so it inherits the workflow's and this run cannot say what it holds`);
  const scopes = [];
  for (const line of body.slice(block + 1)) {
    const match = /^      ([a-z-]+):\s*(\S+)\s*$/.exec(line);
    if (!match) break;
    scopes.push([match[1], match[2]]);
  }
  if (scopes.length === 0) throw new Error(`the ${jobId} job's permissions block is empty in the authority's own workflow`);
  return scopes;
}

export function refuseAnyWriteScope({ workflowPath, jobId, env = process.env }) {
  const scopes = jobScopes({ workflowText: fs.readFileSync(workflowPath, 'utf8'), jobId });
  const writes = scopes.filter(([, value]) => value !== 'none' && value !== 'read').map(([name, value]) => `${name}: ${value}`);
  if (writes.length > 0) throw new Error(`the ${jobId} job is declared with ${writes.join(', ')}; the job that runs candidate code holds contents: read and nothing else`);
  for (const variable of ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) {
    if (env[variable]) throw new Error(`${variable} is present in this job, so it can mint an OIDC token whatever its permissions block says`);
  }
  return scopes.map(([name, value]) => `${name}: ${value}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const held = refuseAnyWriteScope({ workflowPath: process.env.WORKFLOW_PATH, jobId: process.env.MEASURE_JOB_ID || 'measure' });
    console.log(`the job that runs candidate code holds ${held.join(', ')}, and no id-token request URL is present`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
