import { randomUUID } from 'node:crypto';
import { observedJob, type Telemetry } from './index.js';
import type { Alert } from './alerts.js';
export type {Alert} from './alerts.js';

export const JOB_NAMES = ['heartbeat', 'missed_run_check'] as const;
export type JobName = typeof JOB_NAMES[number];
export const JOB_OUTCOMES = ['succeeded', 'failed', 'refused_overlap'] as const;
export type JobOutcome = typeof JOB_OUTCOMES[number];
export interface JobRun { readonly runId:string;readonly jobName:JobName;readonly startedAt:Date;readonly finishedAt:Date;readonly durationMs:number;readonly outcome:JobOutcome }
export interface JobSummary { readonly jobName:JobName;readonly lastRun:JobRun|null;readonly lastSucceededAt:Date|null;readonly leaseExpiresAt:Date|null }
export interface JobStore {
  takeLease(jobName:JobName,runId:string,now:Date,expiresAt:Date):Promise<boolean>;
  renewLease(jobName:JobName,runId:string,now:Date,expiresAt:Date):Promise<boolean>;
  releaseLease(jobName:JobName,runId:string):Promise<void>;
  recordRun(run:JobRun):Promise<void>;
  summaries(jobNames:readonly JobName[]):Promise<readonly JobSummary[]>;
}
export interface RegisteredJob { readonly name:JobName;readonly intervalMs:number;readonly work:(signal:AbortSignal)=>Promise<unknown> }
export const JOB_INTERVALS:Readonly<Record<JobName,number>>=Object.freeze({heartbeat:60_000,missed_run_check:60_000});
export const MISSED_GRACE_FACTOR=1.5;
export const jobRegistry=(work:Partial<Record<JobName,RegisteredJob['work']>>={}):readonly RegisteredJob[]=>JOB_NAMES.map(name=>Object.freeze({name,intervalMs:JOB_INTERVALS[name],work:work[name]??(async()=>undefined)}));
export const jobAlert=(code:'job_failed'|'job_overlap'|'job_missed',jobName:JobName):Alert=>({code,jobName,owner:'platform-on-call',runbook:'docs/observability.md'});
export class LeaseLostError extends Error { constructor(){super('job lease lost');this.name='LeaseLostError'} }
export interface RunnerOptions { now?:()=>Date;setInterval?:(fn:()=>void,ms:number)=>ReturnType<typeof globalThis.setInterval>;clearInterval?:(timer:ReturnType<typeof globalThis.setInterval>)=>void;leaseMs?:number;telemetry?:Telemetry;alert?:(alert:Alert)=>void;runId?:()=>string }
export async function runJob(job:RegisteredJob,store:JobStore,options:RunnerOptions={}):Promise<unknown>{
  const now=options.now??(()=>new Date()),leaseMs=options.leaseMs??30_000,runId=(options.runId??randomUUID)(),startedAt=now();
  if(!await store.takeLease(job.name,runId,startedAt,new Date(startedAt.getTime()+leaseMs))){const finishedAt=now();await store.recordRun({runId,jobName:job.name,startedAt,finishedAt,durationMs:Math.max(0,finishedAt.getTime()-startedAt.getTime()),outcome:'refused_overlap'});options.alert?.(jobAlert('job_overlap',job.name));return undefined}
  const controller=new AbortController();let lost=false,renewing=false;
  const renew=async()=>{if(renewing||lost)return;renewing=true;try{const at=now();if(!await store.renewLease(job.name,runId,at,new Date(at.getTime()+leaseMs))){lost=true;controller.abort()}}catch{lost=true;controller.abort()}finally{renewing=false}};
  const timer=(options.setInterval??globalThis.setInterval)(()=>{void renew()},Math.max(1,Math.floor(leaseMs/3)));timer.unref?.();
  let outcome:JobOutcome='succeeded';
  try{const result=await observedJob(()=>job.work(controller.signal),options.telemetry,job.name);if(lost)throw new LeaseLostError();return result}catch(error){outcome='failed';options.alert?.(jobAlert('job_failed',job.name));throw error}finally{(options.clearInterval??globalThis.clearInterval)(timer);const finishedAt=now();await store.recordRun({runId,jobName:job.name,startedAt,finishedAt,durationMs:Math.max(0,finishedAt.getTime()-startedAt.getTime()),outcome});await store.releaseLease(job.name,runId)}
}
export async function missedJobAlerts(store:Pick<JobStore,'summaries'>,jobs:readonly RegisteredJob[],now=new Date(),grace=MISSED_GRACE_FACTOR):Promise<Alert[]>{const summaries=await store.summaries(jobs.map(j=>j.name));const byName=new Map(summaries.map(s=>[s.jobName,s]));return jobs.filter(j=>{const last=byName.get(j.name)?.lastSucceededAt;return !last||now.getTime()-last.getTime()>j.intervalMs*grace}).map(j=>jobAlert('job_missed',j.name))}

export class InMemoryJobStore implements JobStore {
  readonly runs:JobRun[]=[];readonly leases=new Map<JobName,{runId:string;expiresAt:Date}>();
  async takeLease(name:JobName,id:string,now:Date,expiresAt:Date){const lease=this.leases.get(name);if(lease&&lease.expiresAt>now)return false;this.leases.set(name,{runId:id,expiresAt});return true}
  async renewLease(name:JobName,id:string,now:Date,expiresAt:Date){const lease=this.leases.get(name);if(!lease||lease.runId!==id||lease.expiresAt<=now)return false;this.leases.set(name,{runId:id,expiresAt});return true}
  async releaseLease(name:JobName,id:string){if(this.leases.get(name)?.runId===id)this.leases.delete(name)}
  async recordRun(run:JobRun){this.runs.push(Object.freeze({...run}))}
  async summaries(names:readonly JobName[]){return names.map(jobName=>{const rows=this.runs.filter(r=>r.jobName===jobName).sort((a,b)=>b.startedAt.getTime()-a.startedAt.getTime());return{jobName,lastRun:rows[0]??null,lastSucceededAt:rows.find(r=>r.outcome==='succeeded')?.finishedAt??null,leaseExpiresAt:this.leases.get(jobName)?.expiresAt??null}})}
}
