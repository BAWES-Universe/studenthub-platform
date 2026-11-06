import pg from "pg";
import { databaseUrl } from "./connection.js";
type JobName="heartbeat"|"missed_run_check"|"email_delivery";type JobOutcome="succeeded"|"failed"|"refused_overlap";interface JobRun{readonly runId:string;readonly jobName:JobName;readonly startedAt:Date;readonly finishedAt:Date;readonly durationMs:number;readonly outcome:JobOutcome}
type Row={run_id:string;job_name:JobName;started_at:Date;finished_at:Date;duration_ms:number;outcome:JobRun["outcome"]};
const mapped=(row:Row):JobRun=>({runId:row.run_id,jobName:row.job_name,startedAt:row.started_at,finishedAt:row.finished_at,durationMs:row.duration_ms,outcome:row.outcome});
export class PostgresJobRunsStore {
  readonly #pool:pg.Pool;readonly #owns:boolean;
  constructor(options:{connectionString?:string;pool?:pg.Pool}={}){this.#owns=!options.pool;this.#pool=options.pool??new pg.Pool({connectionString:options.connectionString??databaseUrl()})}
  async close(){if(this.#owns)await this.#pool.end()}
  async acquire(name:JobName,id:string,leaseMs:number,_now:Date){return (await this.#pool.query(`INSERT INTO job_leases(job_name,holder_run_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+($3*interval '1 millisecond')) ON CONFLICT(job_name) DO UPDATE SET holder_run_id=EXCLUDED.holder_run_id,expires_at=EXCLUDED.expires_at WHERE job_leases.expires_at <= CURRENT_TIMESTAMP RETURNING job_name`,[name,id,leaseMs])).rowCount===1}
  async renew(name:JobName,id:string,leaseMs:number,_now:Date){return (await this.#pool.query(`UPDATE job_leases SET expires_at=CURRENT_TIMESTAMP+($3*interval '1 millisecond') WHERE job_name=$1 AND holder_run_id=$2 AND expires_at>CURRENT_TIMESTAMP`,[name,id,leaseMs])).rowCount===1}
  async release(name:JobName,id:string){await this.#pool.query(`DELETE FROM job_leases WHERE job_name=$1 AND holder_run_id=$2`,[name,id])}
  async record(run:JobRun){await this.#pool.query(`INSERT INTO job_runs(run_id,job_name,started_at,finished_at,duration_ms,outcome) VALUES($1,$2,$3,$4,$5,$6)`,[run.runId,run.jobName,run.startedAt,run.finishedAt,run.durationMs,run.outcome])}
  async latest(){const rows=(await this.#pool.query<Row>(`SELECT DISTINCT ON(job_name) run_id,job_name,started_at,finished_at,duration_ms,outcome FROM job_runs ORDER BY job_name,started_at DESC,finished_at DESC,run_id DESC`)).rows;return rows.map(mapped)}
  async lastSuccesses(){const rows=(await this.#pool.query<{job_name:JobName;finished_at:Date}>(`SELECT job_name,max(finished_at) finished_at FROM job_runs WHERE outcome='succeeded' GROUP BY job_name`)).rows;return new Map(rows.map(row=>[row.job_name,row.finished_at]))}
}
