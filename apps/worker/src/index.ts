import { Telemetry, telemetryMode, observedJob, createJobRegistry, runJob, JOB_NAMES, writeJobAlert, type JobAlert, type JobRunsStore } from '../../../packages/observability/src/index.js';
import { PostgresJobRunsStore,PostgresEmailOutboxStore } from '../../../packages/db/src/index.js';
import {createEmailDeliveryJob}from'../../../packages/notifications/src/email-outbox.js';
import {UnconfiguredEmailPort}from'../../../packages/notifications/src/email-port.js';
import {EMAIL_TEMPLATES}from'../../../packages/notifications/src/email-templates.js';
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
  const store = new PostgresJobRunsStore(),outbox=new PostgresEmailOutboxStore({templates:EMAIL_TEMPLATES});
  try {
    const [rawCommand,rawName]=process.argv.slice(2),command=rawCommand??"run",name=rawName??"heartbeat";
    if(command!=="run"||!JOB_NAMES.includes(name as typeof JOB_NAMES[number])){process.stderr.write("usage: worker run <heartbeat|missed_run_check|email_delivery>\n");process.exitCode=1}
    else {const emit=(value:JobAlert)=>writeJobAlert(value),jobStore:JobRunsStore={acquire:(...args)=>Reflect.apply(store.acquire,store,args),renew:(...args)=>Reflect.apply(store.renew,store,args),release:(...args)=>Reflect.apply(store.release,store,args),record:(...args)=>Reflect.apply(store.record,store,args),latest:()=>store.latest(),lastSuccesses:()=>store.lastSuccesses()},registry=createJobRegistry(jobStore,emit,createEmailDeliveryJob(outbox,new UnconfiguredEmailPort(),false));const job=registry.find(value=>value.name===name)!;const result=await runJob(job.name==="heartbeat"?{...job,work:async()=>createWorkerHeartbeat()}:job,jobStore,{telemetry,alert:emit});if(result!==undefined)process.stdout.write(`${JSON.stringify(result)}\n`)}
    // Bounded diagnostic drain belongs to CLI shutdown, never a business request.
    await telemetry.snapshot();
  } catch { process.exitCode=1; } finally { await Promise.all([telemetry.close(),store.close(),outbox.close()]); }
}
