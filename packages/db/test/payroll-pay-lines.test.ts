import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '@studenthub/db';
import { validatePayLine } from '../../payroll/src/pay-lines.js';
import { PostgresPayLinesStore } from '../src/payroll/postgres-pay-lines-store.js';
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL});
let store: PostgresPayLinesStore, person: string, actor: string, company: string, storeId: string;
before(async()=>{
 await runMigrations(pool);
 person='f1-person-'+randomUUID(); actor='f1-staff-'+randomUUID(); company='f1-company-'+randomUUID(); storeId=randomUUID();
 await pool.query('INSERT INTO organizations(id,name) VALUES($1,$1)',[company]);
 for(const id of [person,actor]) await pool.query('INSERT INTO principals(id) VALUES($1)',[id]);
 await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Synthetic shop',$3,$3)",[storeId,company,'a'.repeat(64)]);
 await pool.query("INSERT INTO work_assignments(id,person_principal_id,org_id,store_id,contract_resolution,start_date,end_date,source,created_by) VALUES($1,$2,$3,$4,'{}','2026-11-01','2026-11-30','staff',$5)",[randomUUID(),person,company,storeId,actor]);
 // Synthetic fixture policy only. Production policy is mandatory and not wired by this slice.
 store=new PostgresPayLinesStore(pool,async(_c,a,co)=>a===actor&&co===company,validatePayLine);
});
after(()=>pool.end());
const line=(id=randomUUID())=>({id,personId:person,storeId,currencyCode:'KWD',candidateTotal:'12.500',companyTotal:'15.000',note:'synthetic',calculation:{source:'manual',minutes:150}});
async function transfer(){const id=randomUUID();await store.create(actor,{id,companyId:company,periodStart:'2026-11-01',periodEnd:'2026-11-30',currencyCode:'KWD'});return id;}
test('F1_PG create, append, edit and audit are exact',async()=>{
 const id=await transfer(), l=line(); assert.equal(await store.appendLines(actor,id,0,[l]),1); assert.equal(await store.editLine(actor,id,1,{...l,candidateTotal:'13.000'}),2);
 assert.equal((await pool.query('SELECT candidate_total FROM pay_transfer_lines WHERE id=$1',[l.id])).rows[0].candidate_total,'13.000');
 const rows=(await pool.query('SELECT operation,before_value,after_value FROM pay_line_audit WHERE transfer_id=$1 ORDER BY id',[id])).rows;
 assert.deepEqual(rows.map(x=>x.operation),['create_transfer','add_line','edit_line']); assert.equal(rows[2].before_value.candidate_total,'12.500'); assert.equal(rows[2].after_value.candidateTotal,'13.000');
});
test('F1_PG late batch failure rolls back lines audit and version',async()=>{
 const id=await transfer(); await assert.rejects(store.appendLines(actor,id,0,[line(),{...line(),currencyCode:'USD'}]),/currency_mismatch/);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM pay_transfer_lines WHERE transfer_id=$1',[id])).rows[0].n,0);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM pay_line_audit WHERE transfer_id=$1',[id])).rows[0].n,1);
 assert.equal((await pool.query('SELECT version FROM pay_transfers WHERE id=$1',[id])).rows[0].version,0);
});
test('F1_PG assignment, policy, draft state and stale version guards',async()=>{
 const id=await transfer(); await assert.rejects(store.appendLines(person,id,0,[line()]),/not_found/);
 const other='f1-other-'+randomUUID();await pool.query('INSERT INTO principals(id) VALUES($1)',[other]);await assert.rejects(store.appendLines(actor,id,0,[{...line(),personId:other}]),/person_not_assigned/);
 const l=line(); await store.appendLines(actor,id,0,[l]); await assert.rejects(store.editLine(actor,id,0,l),/version_conflict/);
 await pool.query("UPDATE pay_transfers SET status='locked' WHERE id=$1",[id]); await assert.rejects(store.editLine(actor,id,1,l),/transfer_not_draft/);
 await assert.rejects(pool.query("UPDATE pay_transfer_lines SET candidate_total=99 WHERE id=$1",[l.id]),/not editable/);
});
test('F1_PG concurrent same-version edits permit one committed writer',async()=>{
 const id=await transfer(); const results=await Promise.allSettled([store.appendLines(actor,id,0,[line()]),store.appendLines(actor,id,0,[line()])]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1); assert.equal((await pool.query('SELECT count(*)::int AS n FROM pay_transfer_lines WHERE transfer_id=$1',[id])).rows[0].n,1);
});

test('F1_PG nested JSON snapshots are private frozen values shared by validation storage and audit',async()=>{
 const id=await transfer(); const l={...line(),calculation:{source:'synthetic',nested:{hours:2,approved:true,reason:null,refs:['one','two']}}};
 let validations=0;
 const checked=new PostgresPayLinesStore(pool,async(_c,a,co)=>a===actor&&co===company,(snapshot)=>{
   validatePayLine(snapshot); validations++;
   assert.notEqual(snapshot,l); assert.notEqual(snapshot.calculation,l.calculation);
   assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.calculation));
   const nested=snapshot.calculation.nested as {refs:readonly string[]};
   assert.ok(Object.isFrozen(nested)); assert.ok(Object.isFrozen(nested.refs));
 });
 await checked.appendLines(actor,id,0,[l]);
 await checked.editLine(actor,id,1,{...l,note:'updated'});
 assert.equal(validations,2);
 const stored=(await pool.query('SELECT calculation,note FROM pay_transfer_lines WHERE id=$1',[l.id])).rows[0];
 const audit=(await pool.query("SELECT after_value FROM pay_line_audit WHERE line_id=$1 ORDER BY id DESC LIMIT 1",[l.id])).rows[0].after_value;
 assert.deepEqual(stored.calculation,l.calculation); assert.deepEqual(audit.calculation,stored.calculation); assert.equal(audit.note,stored.note);
});
test('F1_PG accepted uppercase UUID retains edit identity and audit continuity',async()=>{
 const id=await transfer(),l={...line(),storeId:storeId.toUpperCase()};
 await store.appendLines(actor,id,0,[l]); await store.editLine(actor,id,1,{...l,note:'same store'});
 const row=(await pool.query('SELECT store_id,note FROM pay_transfer_lines WHERE id=$1',[l.id])).rows[0];
 assert.equal(row.store_id,storeId); assert.equal(row.note,'same store');
});
test('F1_PG transfer policy insert audit agree and audit schema covers mutation events and all three tables retain their rows',async()=>{
 const seen:string[]=[];const checked=new PostgresPayLinesStore(pool,async(_c,a,co)=>{seen.push(co);return a===actor&&co===company;},validatePayLine);
 const draft={id:randomUUID(),companyId:company,periodStart:'2026-11-01',periodEnd:'2026-11-30',currencyCode:'KWD'};
 await checked.create(actor,Object.freeze(draft));
 assert.deepEqual(seen,[company]); const row=(await pool.query('SELECT company_id FROM pay_transfers WHERE id=$1',[draft.id])).rows[0];
 const audit=(await pool.query('SELECT after_value FROM pay_line_audit WHERE transfer_id=$1',[draft.id])).rows[0].after_value;
 assert.equal(row.company_id,company);assert.deepEqual(audit,draft);
 const triggers=(await pool.query("SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid='pay_line_audit'::regclass AND NOT tgisinternal")).rows.map(x=>x.definition).join('\n');
 assert.match(triggers,/BEFORE DELETE OR UPDATE|BEFORE UPDATE OR DELETE/);assert.match(triggers,/BEFORE TRUNCATE/);assert.match(triggers,/FOR EACH STATEMENT EXECUTE FUNCTION pay_line_audit_immutable/);
});

test('F1_PG every retained payroll table has its enabled before-statement retention guard',async()=>{
 const guards=[
  ['pay_transfers','pay_transfers_no_truncate','pay_transfer_rows_retained'],
  ['pay_transfer_lines','pay_transfer_lines_no_truncate','pay_transfer_rows_retained'],
  ['pay_line_audit','pay_line_audit_no_truncate','pay_line_audit_immutable'],
 ] as const;
 for (const [table,trigger,handler] of guards) {
  const {rows}=await pool.query(`SELECT tgtype::int AS type,tgenabled AS enabled,p.proname AS handler
   FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
   WHERE tgrelid=$1::regclass AND tgname=$2 AND NOT tgisinternal`,[table,trigger]);
  assert.deepEqual(rows,[{type:34,enabled:'O',handler}]);
 }
});
