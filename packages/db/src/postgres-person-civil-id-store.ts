import pg from "pg";
import { databaseUrl } from "./connection.js";

type CivilIdCountry="KW"|"BH";
type Sealed={ciphertext:Buffer;hash:Buffer;keyVersion:number};
type CivilIdRecord={principalId:string;country:CivilIdCountry|null;sealed:Sealed|null;expiry:string|null;needsReview:boolean;revision:number;writtenAt:string;updatedAt:string;releasedAt:string|null};
type CivilIdWrite={principalId:string;submissionId:string;revision:number;country:CivilIdCountry|null;sealed:Sealed|null;expiry:string|null;changed:readonly ("country"|"number"|"expiry")[];occurredAt:string};
type CivilIdStoreResult={ok:true;record:CivilIdRecord}|{ok:false;reason:"duplicate"|"stale_revision"|"submission_reused"};

type Row = { principal_id:string; country:CivilIdCountry|null; number_ciphertext:Buffer|null; number_hash:Buffer|null; key_version:number|null; expiry_date:string|null; needs_review:boolean; revision:number; written_at:string; updated_at:string; released_at:string|null };
const record = (r: Row): CivilIdRecord => ({ principalId:r.principal_id, country:r.country,
  sealed:r.number_ciphertext && r.number_hash && r.key_version !== null ? {ciphertext:r.number_ciphertext,hash:r.number_hash,keyVersion:r.key_version}:null,
  expiry:r.expiry_date, needsReview:r.needs_review, revision:r.revision, writtenAt:new Date(r.written_at).toISOString(), updatedAt:new Date(r.updated_at).toISOString(), releasedAt:r.released_at ? new Date(r.released_at).toISOString():null });

export class PostgresPersonCivilIdStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: {connectionString?:string;pool?:pg.Pool}={}) { this.#owns=!options.pool; this.#pool=options.pool??new pg.Pool({connectionString:options.connectionString??databaseUrl()}); }
  async close(){if(this.#owns)await this.#pool.end();}
  async read(principalId:string){const {rows}=await this.#pool.query<Row>(`SELECT principal_id::text,country,number_ciphertext,number_hash,key_version,expiry_date::text,needs_review,revision,written_at::text,updated_at::text,released_at::text FROM person_civil_ids WHERE principal_id=$1::text`,[principalId]);return rows[0]?record(rows[0]):null;}
  async numberAvailable(principalId:string,country:CivilIdCountry,hash:Buffer){const {rows}=await this.#pool.query(`SELECT 1 FROM person_civil_ids WHERE principal_id<>$1::text AND country=$2::text AND number_hash=$3::bytea AND released_at IS NULL`,[principalId,country,hash]);return rows.length===0;}
  async save(w:CivilIdWrite):Promise<CivilIdStoreResult>{const client=await this.#pool.connect();try{await client.query("BEGIN");
    const current=await client.query<Row>(`SELECT principal_id::text,country,number_ciphertext,number_hash,key_version,expiry_date::text,needs_review,revision,written_at::text,updated_at::text,released_at::text FROM person_civil_ids WHERE principal_id=$1::text FOR UPDATE`,[w.principalId]);
    if((current.rows[0]?.revision??0)!==w.revision){await client.query("ROLLBACK");return {ok:false,reason:"stale_revision"};}
    const old=current.rows[0]; const review=(old?.needs_review??false)||w.changed.includes("number")||w.changed.includes("expiry");
    const result=await client.query<Row>(`INSERT INTO person_civil_ids(principal_id,country,number_ciphertext,number_hash,key_version,expiry_date,needs_review,revision,written_at,updated_at,released_at)
      VALUES($1::text,$2::text,$3::bytea,$4::bytea,$5::smallint,$6::date,$7::boolean,$8::integer,$9::timestamptz,$9::timestamptz,NULL)
      ON CONFLICT(principal_id) DO UPDATE SET country=EXCLUDED.country,number_ciphertext=EXCLUDED.number_ciphertext,number_hash=EXCLUDED.number_hash,key_version=EXCLUDED.key_version,expiry_date=EXCLUDED.expiry_date,needs_review=EXCLUDED.needs_review,revision=EXCLUDED.revision,updated_at=EXCLUDED.updated_at,released_at=NULL
      RETURNING principal_id::text,country,number_ciphertext,number_hash,key_version,expiry_date::text,needs_review,revision,written_at::text,updated_at::text,released_at::text`,[w.principalId,w.country,w.sealed?.ciphertext??null,w.sealed?.hash??null,w.sealed?.keyVersion??null,w.expiry,review,w.revision+1,w.occurredAt]);
    await client.query(`INSERT INTO person_civil_id_events(principal_id,submission_id,kind,changed,occurred_at) VALUES($1::text,$2::uuid,'person_changed',$3::text[],$4::timestamptz)`,[w.principalId,w.submissionId,w.changed,w.occurredAt]);
    await client.query("COMMIT");return {ok:true,record:record(result.rows[0]!)};
  }catch(e){await client.query("ROLLBACK").catch(()=>{});const x=e as {code?:string;constraint?:string};if(x.code==="23505"){if(x.constraint==="person_civil_ids_active_number")return {ok:false,reason:"duplicate"};if(x.constraint==="person_civil_id_events_submission")return {ok:false,reason:"submission_reused"};}throw e;}finally{client.release();}}
  async release(principalId:string,at:string){await this.#pool.query(`UPDATE person_civil_ids SET released_at=$2::timestamptz,updated_at=$2::timestamptz,revision=revision+1 WHERE principal_id=$1::text AND released_at IS NULL`,[principalId,at]);}
  async decryptNumber(principalId:string,vault:{open(principalId:string,country:CivilIdCountry,ciphertext:Buffer):string}){const row=await this.read(principalId);return row?.sealed&&row.country?vault.open(principalId,row.country,row.sealed.ciphertext):null;}
}
