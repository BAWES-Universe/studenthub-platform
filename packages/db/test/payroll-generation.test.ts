import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {runMigrations} from "@studenthub/db";
import {PostgresPayLinesStore} from "../src/payroll/postgres-pay-lines-store.js";
import {PostgresGenerationStore,type LockedGenerationBatch} from "../src/payroll/postgres-generation-store.js";
import {validatePayLine} from "../../payroll/src/pay-lines.js";
import {commitGeneration} from "../../payroll/src/generation-transaction.js";
// Only accept a plain disposable-DB URL, then pass validated fields to pg rather than
// letting a second URL parser reinterpret the connection target.
const connectionString=process.env.DATABASE_URL;
if(!connectionString)throw Error("F2 tests require explicit local disposable DATABASE_URL (no default)");
const databaseUrl=new URL(connectionString);
if(!["postgres:","postgresql:"].includes(databaseUrl.protocol)||
   !["localhost","127.0.0.1","[::1]"].includes(databaseUrl.hostname)||
   databaseUrl.search||databaseUrl.hash||databaseUrl.pathname.length<2||databaseUrl.port==="0"){
 throw Error("F2 tests require a plain local DATABASE_URL with an explicit database name");
}
const pool=new pg.Pool({
 host:databaseUrl.hostname==="[::1]"?"::1":"127.0.0.1",
 port:Number(databaseUrl.port||"5432"),
 user:decodeURIComponent(databaseUrl.username),
 password:decodeURIComponent(databaseUrl.password),
 database:decodeURIComponent(databaseUrl.pathname.slice(1)),
});
before(async()=>{
 await runMigrations(pool);
 const ledger=await pool.query("SELECT version FROM schema_migrations WHERE version = ANY($1::text[]) ORDER BY version",[["0550_pay_transfer_lines","0556_pay_generation_claims"]]);
 assert.deepEqual(ledger.rows.map(row=>row.version),["0550_pay_transfer_lines","0556_pay_generation_claims"],"F1/F2 migrations must be applied through the normal ledger");
});
after(()=>pool.end());
async function fixture(){
 const person=randomUUID(),actor=randomUUID(),company=randomUUID(),storeId=randomUUID();
 await pool.query("INSERT INTO organizations(id,name) VALUES($1,'synthetic')",[company]);for(const id of [person,actor])await pool.query("INSERT INTO principals(id) VALUES($1)",[id]);
 await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Synthetic',$3,$3)",[storeId,company,"a".repeat(64)]);
 await pool.query("INSERT INTO work_assignments(id,person_principal_id,org_id,store_id,contract_resolution,start_date,end_date,source,created_by) VALUES($1,$2,$3,$4,'{}','2026-11-01','2026-11-30','staff',$5)",[randomUUID(),person,company,storeId,actor]);
 let allowed=true;const policy=async(_c:pg.PoolClient,a:string,co:string)=>allowed&&a===actor&&co===company;
 const writer=new PostgresPayLinesStore(pool,policy,validatePayLine);
 const transfer=async()=>{const id=randomUUID();await writer.create(actor,{id,companyId:company,periodStart:"2026-11-01",periodEnd:"2026-11-30",currencyCode:"KWD"});return id;};
 const batch=(currency="KWD"):LockedGenerationBatch=>({kind:"preview-only",key:"batch",revision:"r1",blocked:[],adjustmentReviews:[],totals:{},lines:[{id:randomUUID(),personId:person,storeId,currencyCode:currency,candidateTotal:"100.000",companyTotal:"150.000",note:"synthetic monthly",calculation:{contractId:"monthly",candidateKey:"candidate",period:{start:"2026-11-01",end:"2026-11-30"},provenance:{}}}]});
 return {person,actor,writer,transfer,batch,policy,deny:()=>{allowed=false;}};
}
const command=(actor:string,transferId:string)=>({actorId:actor,transferId,expectedVersion:0,batchKey:"batch",expectedRevision:"r1"});
test("F2_PG same batch concurrent retry commits once, replays after lock, reauthorizes",async()=>{
 const f=await fixture(),id=await f.transfer(),b=f.batch();let builds=0;const store=new PostgresGenerationStore(pool,f.policy,validatePayLine,async()=>{builds++;return b;});
 const out=await Promise.all([commitGeneration(store,command(f.actor,id)),commitGeneration(store,command(f.actor,id))]);assert.deepEqual(out.map(r=>r.kind).sort(),["committed","replayed"]);assert.equal(builds,1);
 await pool.query("UPDATE pay_transfers SET status='locked' WHERE id=$1",[id]);assert.equal((await commitGeneration(store,command(f.actor,id))).kind,"replayed");f.deny();await assert.rejects(commitGeneration(store,command(f.actor,id)),/not_found/);
});
test("F2_PG distinct transfers cannot claim same person contract period",async()=>{
 const f=await fixture(),a=await f.transfer(),b=await f.transfer();const store=new PostgresGenerationStore(pool,f.policy,validatePayLine,async()=>f.batch());
 const out=await Promise.allSettled([commitGeneration(store,command(f.actor,a)),commitGeneration(store,command(f.actor,b))]);assert.equal(out.filter(r=>r.status==="fulfilled").length,1);assert.equal((await pool.query("SELECT * FROM pay_generation_claims WHERE person_id=$1",[f.person])).rowCount,1);
});
test("F2_PG late F1 failure rolls claims audit receipt back and retry succeeds",async()=>{
 const f=await fixture(),id=await f.transfer();let bad=true;const store=new PostgresGenerationStore(pool,f.policy,validatePayLine,async()=>f.batch(bad?"USD":"KWD"));
 await assert.rejects(commitGeneration(store,command(f.actor,id)),/currency_mismatch/);
 assert.equal((await pool.query("SELECT * FROM pay_generation_claims WHERE person_id=$1",[f.person])).rowCount,0);assert.equal((await pool.query("SELECT * FROM pay_generation_receipts WHERE transfer_id=$1",[id])).rowCount,0);assert.equal((await pool.query("SELECT * FROM pay_line_audit WHERE transfer_id=$1",[id])).rowCount,1);
 bad=false;assert.equal((await commitGeneration(store,command(f.actor,id))).kind,"committed");
});
test("F2_PG manual first blocks generation; generated first blocks duplicate manual, note edit survives",async()=>{
 for(const manualFirst of [true,false]){const f=await fixture(),manual=await f.transfer(),generated=await f.transfer(),line={...f.batch().lines[0]!,calculation:{source:"manual"}};
 const store=new PostgresGenerationStore(pool,f.policy,validatePayLine,async()=>f.batch());
 if(manualFirst){await f.writer.appendLines(f.actor,manual,0,[line]);await assert.rejects(commitGeneration(store,command(f.actor,generated)),/claim_conflict/);await f.writer.editLine(f.actor,manual,1,{...line,note:"note only"});}
 else{const r=await commitGeneration(store,command(f.actor,generated));await assert.rejects(f.writer.appendLines(f.actor,manual,0,[line]),/claim conflict/);await pool.query("UPDATE pay_transfer_lines SET note='note only',paid=true WHERE id=$1",[r.receipt.lineIds[0]]);}
 assert.equal((await pool.query("SELECT * FROM pay_transfer_lines WHERE person_id=$1",[f.person])).rowCount,1);
 }
});
test("F2_PG missing confirmation fails closed before claims",async()=>{
 const f=await fixture(),id=await f.transfer();const store=new PostgresGenerationStore(pool,f.policy,validatePayLine,async()=>({...f.batch(),blocked:[{key:"candidate",reason:"month_confirmation_port_required"}]}));await assert.rejects(commitGeneration(store,command(f.actor,id)),/not_ready/);assert.equal((await pool.query("SELECT * FROM pay_generation_claims WHERE person_id=$1",[f.person])).rowCount,0);
});
test("F2_PG shared root cannot be reserved under another contract",async()=>{
 const f=await fixture(),a=await f.transfer(),b=await f.transfer(),root=randomUUID();
 const store=new PostgresGenerationStore(pool,f.policy,validatePayLine,async(_c,id)=>{const batch=f.batch();return {...batch,lines:batch.lines.map(l=>({...l,calculation:{...l.calculation,contractId:id===a?"one":"two",provenance:{roots:[root]}}}))};});
 await commitGeneration(store,command(f.actor,a));await assert.rejects(commitGeneration(store,command(f.actor,b)),/claim_conflict/);assert.equal((await pool.query("SELECT * FROM pay_generation_claims WHERE transfer_id=$1",[b])).rowCount,0);assert.equal((await pool.query("SELECT * FROM pay_generation_roots WHERE root_id=$1",[root])).rowCount,1);
});
test("F2_PG receipt insertion failure rolls back appended lines and claims",async()=>{
 const f=await fixture(),id=await f.transfer();const store=new PostgresGenerationStore(pool,f.policy,validatePayLine,async()=>f.batch());
 // Disposable database only; remove fault before leaving test.
 await pool.query(`CREATE FUNCTION synthetic_receipt_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$; CREATE TRIGGER synthetic_receipt_fail BEFORE INSERT ON pay_generation_receipts FOR EACH ROW WHEN (NEW.transfer_id='${id}') EXECUTE FUNCTION synthetic_receipt_fail()`);
 try{await assert.rejects(commitGeneration(store,command(f.actor,id)),/synthetic receipt failure/);}finally{await pool.query("DROP TRIGGER synthetic_receipt_fail ON pay_generation_receipts; DROP FUNCTION synthetic_receipt_fail()");}
 for(const table of ["pay_generation_claims","pay_transfer_lines","pay_generation_receipts"]){assert.equal((await pool.query(`SELECT * FROM ${table} WHERE transfer_id=$1`,[id])).rowCount,0);}
 assert.equal((await pool.query("SELECT version FROM pay_transfers WHERE id=$1",[id])).rows[0].version,0);
 assert.equal((await commitGeneration(store,command(f.actor,id))).kind,"committed");
});
test("F2_PG overlapping unknown manual period is an explicit conservative block",async()=>{
 const f=await fixture(),manual=await f.transfer(),generated=await f.transfer();await pool.query("UPDATE pay_transfers SET period_start='2026-11-10',period_end='2026-11-20' WHERE id=$1",[manual]);
 await f.writer.appendLines(f.actor,manual,0,[{...f.batch().lines[0]!,calculation:{source:"manual"}}]);
 const store=new PostgresGenerationStore(pool,f.policy,validatePayLine,async()=>f.batch());await assert.rejects(commitGeneration(store,command(f.actor,generated)),/claim_conflict/);assert.equal((await pool.query("SELECT * FROM pay_generation_claims WHERE person_id=$1",[f.person])).rowCount,0);
});
test("F2_PG concurrent manual and generated writers across targets commit only one",async()=>{
 const f=await fixture(),manual=await f.transfer(),generated=await f.transfer();const store=new PostgresGenerationStore(pool,f.policy,validatePayLine,async()=>f.batch());
 const out=await Promise.allSettled([f.writer.appendLines(f.actor,manual,0,[{...f.batch().lines[0]!,calculation:{source:"manual"}}]),commitGeneration(store,command(f.actor,generated))]);
 assert.equal(out.filter(x=>x.status==="fulfilled").length,1);assert.equal((await pool.query("SELECT * FROM pay_transfer_lines WHERE person_id=$1",[f.person])).rowCount,1);
});
