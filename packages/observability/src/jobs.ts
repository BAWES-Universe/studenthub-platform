import { randomUUID } from "node:crypto";
import { disabledTelemetry, observedJob, type Telemetry } from "./index.js";
import type { Alert } from "./alerts.js";

export const JOB_NAMES = ["heartbeat", "missed_run_check"] as const;
export type JobName = typeof JOB_NAMES[number];
export const JOB_OUTCOMES = ["succeeded", "failed", "refused_overlap"] as const;
export type JobOutcome = typeof JOB_OUTCOMES[number];
export interface JobRun { readonly runId:string;readonly jobName:JobName;readonly startedAt:Date;readonly finishedAt:Date;readonly durationMs:number;readonly outcome:JobOutcome }
export interface Job { readonly name:JobName;readonly intervalMs:number;readonly work:(signal:AbortSignal)=>Promise<unknown> }
export interface JobRunsStore {
  acquire(jobName:JobName,runId:string,expiresAt:Date,now:Date):Promise<boolean>;
  renew(jobName:JobName,runId:string,expiresAt:Date,now:Date):Promise<boolean>;
  release(jobName:JobName,runId:string):Promise<void>;
  record(run:JobRun):Promise<void>;
  latest():Promise<readonly JobRun[]>;
  lastSuccesses():Promise<ReadonlyMap<JobName,Date>>;
}
export type JobAlert = Alert & { readonly jobName:JobName };
export interface RunnerOptions { readonly telemetry?:Telemetry;readonly alert?:(alert:JobAlert)=>void|Promise<void>;readonly now?:()=>Date;readonly leaseMs?:number;readonly setTimer?:(callback:()=>void,delay:number)=>unknown;readonly clearTimer?:(timer:unknown)=>void }
const alert = (code:"job_failed"|"job_overlap"|"job_missed",jobName:JobName):JobAlert => ({code,jobName,owner:"platform-on-call",runbook:"docs/observability.md"});

export async function runJob(job:Job,store:JobRunsStore,options:RunnerOptions={}):Promise<unknown> {
  const now=options.now??(()=>new Date()),runId=randomUUID(),startedAt=now(),leaseMs=options.leaseMs??30_000;
  const acquired=await store.acquire(job.name,runId,new Date(startedAt.getTime()+leaseMs),startedAt);
  if(!acquired){const finishedAt=now();await store.record({runId,jobName:job.name,startedAt,finishedAt,durationMs:Math.max(0,finishedAt.getTime()-startedAt.getTime()),outcome:"refused_overlap"});await options.alert?.(alert("job_overlap",job.name));return undefined}
  const controller=new AbortController();let lost=false,renewing=false;
  const renew=async()=>{if(renewing||controller.signal.aborted)return;renewing=true;try{const at=now();if(!await store.renew(job.name,runId,new Date(at.getTime()+leaseMs),at)){lost=true;controller.abort()}}catch{lost=true;controller.abort()}finally{renewing=false}};
  const setTimer=options.setTimer??((callback,delay)=>setInterval(()=>void callback(),delay));
  const clearTimer=options.clearTimer??(timer=>clearInterval(timer as ReturnType<typeof setInterval>));
  const timer=setTimer(()=>void renew(),Math.max(1,Math.floor(leaseMs/3)));
  let outcome:JobOutcome="succeeded",result:unknown,error:unknown;
  try{result=await observedJob(()=>job.work(controller.signal),options.telemetry??disabledTelemetry,job.name)}catch(caught){outcome="failed";error=caught}
  finally{clearTimer(timer);await renew();if(lost&&outcome==="succeeded"){outcome="failed";error=new Error("job lease lost")}const finishedAt=now();await store.record({runId,jobName:job.name,startedAt,finishedAt,durationMs:Math.max(0,finishedAt.getTime()-startedAt.getTime()),outcome});await store.release(job.name,runId);if(outcome==="failed")await options.alert?.(alert("job_failed",job.name))}
  if(error!==undefined)throw error;return result;
}

export async function missedJobAlerts(jobs:readonly Job[],store:Pick<JobRunsStore,"lastSuccesses">,emit:(alert:JobAlert)=>void|Promise<void>,now=new Date(),graceFactor=1.5):Promise<JobAlert[]> {
  const successes=await store.lastSuccesses(),alerts:JobAlert[]=[];
  for(const job of jobs)if(job.name!=="missed_run_check"&&(!successes.get(job.name)||now.getTime()-successes.get(job.name)!.getTime()>job.intervalMs*graceFactor)){const value=alert("job_missed",job.name);alerts.push(value);await emit(value)}
  return alerts;
}
export function createJobRegistry(store:JobRunsStore,emit:(alert:JobAlert)=>void|Promise<void>=()=>{}):readonly Job[]{
  const jobs:Job[]=[{name:"heartbeat",intervalMs:60_000,work:async()=>({status:"ok"})},{name:"missed_run_check",intervalMs:60_000,work:async()=>{await missedJobAlerts(jobs,store,emit)}}];return Object.freeze(jobs);
}
export class MemoryJobRunsStore implements JobRunsStore {
  readonly runs:JobRun[]=[];readonly leases=new Map<JobName,{holder:string;expiresAt:Date}>();failRenewal=false;
  async acquire(name:JobName,id:string,expiresAt:Date,now:Date){const lease=this.leases.get(name);if(lease&&lease.expiresAt>now)return false;this.leases.set(name,{holder:id,expiresAt});return true}
  async renew(name:JobName,id:string,expiresAt:Date,now:Date){const lease=this.leases.get(name);if(this.failRenewal||!lease||lease.holder!==id||lease.expiresAt<=now)return false;this.leases.set(name,{holder:id,expiresAt});return true}
  async release(name:JobName,id:string){if(this.leases.get(name)?.holder===id)this.leases.delete(name)}
  async record(run:JobRun){this.runs.push(Object.freeze({...run}))}
  async latest(){const result=new Map<JobName,JobRun>();for(const row of [...this.runs].sort((a,b)=>b.startedAt.getTime()-a.startedAt.getTime()))if(!result.has(row.jobName))result.set(row.jobName,row);return [...result.values()]}
  async lastSuccesses(){const result=new Map<JobName,Date>();for(const row of this.runs)if(row.outcome==="succeeded"&&(!result.has(row.jobName)||result.get(row.jobName)!<row.finishedAt))result.set(row.jobName,row.finishedAt);return result}
}
