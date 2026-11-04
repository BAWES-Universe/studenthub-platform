import pg from "pg";
import { databaseUrl } from "./connection.js";
type StoredExport={readonly id:string;readonly kind:string;readonly requesterPrincipalId:string;readonly filters:Readonly<Record<string,unknown>>;readonly rowCount:number;readonly outcome:"created"|"refused_limit"|"refused_authorization";readonly createdAt:Date;readonly expiresAt:Date;readonly bytes:Buffer|null};

export class PostgresExportsStore{
 readonly#pool:pg.Pool;readonly#owns:boolean;
 constructor(options:{connectionString?:string;pool?:pg.Pool}={}){this.#owns=!options.pool;this.#pool=options.pool??new pg.Pool({connectionString:options.connectionString??databaseUrl()});}
 async close(){if(this.#owns)await this.#pool.end();}
 async save(r:StoredExport){await this.#pool.query(`INSERT INTO exports(id,kind,requester_principal_id,filters,row_count,outcome,created_at,expires_at,csv_bytes) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,[r.id,r.kind,r.requesterPrincipalId,JSON.stringify(r.filters),r.rowCount,r.outcome,r.createdAt,r.expiresAt,r.bytes]);}
 async find(id:string):Promise<StoredExport|null>{const{rows}=await this.#pool.query<{id:string;kind:string;requester_principal_id:string;filters:Record<string,unknown>;row_count:number;outcome:"created"|"refused_limit"|"refused_authorization";created_at:Date;expires_at:Date;csv_bytes:Buffer|null}>(`SELECT id,kind,requester_principal_id,filters,row_count,outcome,created_at,expires_at,csv_bytes FROM exports WHERE id=$1`,[id]);const r=rows[0];return r?{id:r.id,kind:r.kind,requesterPrincipalId:r.requester_principal_id,filters:r.filters,rowCount:r.row_count,outcome:r.outcome,createdAt:r.created_at,expiresAt:r.expires_at,bytes:r.csv_bytes}:null;}
 async cleanExpired(now:Date){const result=await this.#pool.query(`UPDATE exports SET csv_bytes=NULL WHERE expires_at <= $1 AND csv_bytes IS NOT NULL`,[now]);return result.rowCount??0;}
}
