import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { PostgresJobRunsStore, runMigrations } from "@studenthub/db";
import { runJob, type Job } from "../../observability/src/jobs.js";

const URL=process.env.DATABASE_URL??"";
let pool:pg.Pool,store:PostgresJobRunsStore;
before(async()=>{if(!URL)throw Error("DATABASE_URL is required to run the db suite");pool=new pg.Pool({connectionString:URL});await runMigrations(pool);store=new PostgresJobRunsStore({pool})});
after(async()=>pool.end());

test("SHU198_LEASE postgres runners have one concurrent worker",async()=>{
  await pool.query("DELETE FROM job_leases WHERE job_name='heartbeat'");
  await pool.query("DELETE FROM job_runs WHERE job_name='heartbeat'");
  let entered!:()=>void,release!:()=>void,runs=0;
  const started=new Promise<void>(resolve=>{entered=resolve}),held=new Promise<void>(resolve=>{release=resolve});
  const job:Job={name:"heartbeat",intervalMs:1000,work:async()=>{runs++;entered();await held}};
  const first=runJob(job,store);await started;
  await runJob(job,store);assert.equal(runs,1);
  release();await first;
  const outcomes=(await pool.query<{outcome:string}>("SELECT outcome FROM job_runs WHERE job_name='heartbeat' ORDER BY started_at")).rows.map(row=>row.outcome).sort();
  assert.deepEqual(outcomes,["refused_overlap","succeeded"]);
});

test("SHU198_RECORDED postgres stores only closed run fields",async()=>{const runId=randomUUID(),now=new Date();await store.record({runId,jobName:"heartbeat",startedAt:now,finishedAt:now,durationMs:0,outcome:"succeeded"});assert.equal((await store.latest()).some(row=>row.runId===runId),true)});
