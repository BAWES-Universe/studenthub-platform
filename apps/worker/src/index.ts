import { Telemetry, telemetryMode, observedJob, createJobRegistry, runJob, JOB_NAMES, writeJobAlert, type JobAlert } from '../../../packages/observability/src/index.js';
import { PostgresJobRunsStore,PostgresEmailOutboxStore } from '../../../packages/db/src/index.js';
import {createEmailDeliveryJob}from'../../../packages/notifications/src/email-outbox.js';
import {UnconfiguredEmailPort}from'../../../packages/notifications/src/email-port.js';
export { observedJob } from '../../../packages/observability/src/index.js';
import { pathToFileURL } from "node:url";

import { createHealthResponse, type HealthResponse } from "@studenthub/contracts";

export function createWorkerHeartbeat(now: Date = new Date()): HealthResponse {
  return createHealthResponse("worker", now);
}
export { writeJobAlert } from '../../../packages/observability/src/index.js';

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  const telemetry = new Telemetry(telemetryMode(process.env));
  const store = new PostgresJobRunsStore(),outbox=new PostgresEmailOutboxStore();
  try {
    const [rawCommand,rawName]=process.argv.slice(2),command=rawCommand??"run",name=rawName??"heartbeat";
    if(command!=="run"||!JOB_NAMES.includes(name as typeof JOB_NAMES[number])){process.stderr.write("usage: worker run <heartbeat|missed_run_check|email_delivery>\n");process.exitCode=1}
    else {const emit=(value:JobAlert)=>writeJobAlert(value),registry=createJobRegistry(store as never,emit,createEmailDeliveryJob(outbox,new UnconfiguredEmailPort(),false));const job=registry.find(value=>value.name===name)!;const result=await runJob(job.name==="heartbeat"?{...job,work:async()=>createWorkerHeartbeat()}:job,store as never,{telemetry,alert:emit});if(result!==undefined)process.stdout.write(`${JSON.stringify(result)}\n`)}
    // Bounded diagnostic drain belongs to CLI shutdown, never a business request.
    await telemetry.snapshot();
  } catch { process.exitCode=1; } finally { await Promise.all([telemetry.close(),store.close(),outbox.close()]); }
}
