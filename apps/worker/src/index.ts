import { Telemetry, telemetryMode, jobRegistry, runJob, missedJobAlerts, JOB_NAMES, type Alert, type JobName, type JobStore } from '../../../packages/observability/src/index.js';
import {PostgresJobRunsStore}from'../../../packages/db/src/postgres-job-runs-store.js';
export { observedJob } from '../../../packages/observability/src/index.js';
import { pathToFileURL } from "node:url";

import { createHealthResponse, type HealthResponse } from "@studenthub/contracts";

export function createWorkerHeartbeat(now: Date = new Date()): HealthResponse {
  return createHealthResponse("worker", now);
}

export function createWorkerJobs(store:Pick<JobStore,'summaries'>,emit:(alert:Alert)=>void=()=>undefined){return jobRegistry({heartbeat:async()=>createWorkerHeartbeat(),missed_run_check:async()=>{for(const alert of await missedJobAlerts(store,createWorkerJobs(store,emit)))emit(alert)}})}
export async function runWorkerCommand(args:readonly string[],store:JobStore,telemetry=new Telemetry(),emit:(alert:Alert)=>void=()=>undefined){if(args[0]!=='run'||!JOB_NAMES.includes(args[1] as JobName))throw new Error('usage: worker run <heartbeat|missed_run_check>');const jobs=createWorkerJobs(store,emit),job=jobs.find(value=>value.name===args[1])!;return runJob(job,store,{telemetry,alert:emit})}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  const telemetry = new Telemetry(telemetryMode(process.env));
  const store=new PostgresJobRunsStore();
  try {
    const result=await runWorkerCommand(process.argv.slice(2),store,telemetry,alert=>process.stderr.write(`${JSON.stringify(alert)}\n`));
    if(result!==undefined)process.stdout.write(`${JSON.stringify(result)}\n`);
    // Bounded diagnostic drain belongs to CLI shutdown, never a business request.
    await telemetry.snapshot();
  } finally { await Promise.all([telemetry.close(),store.close()]); }
}
