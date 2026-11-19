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
