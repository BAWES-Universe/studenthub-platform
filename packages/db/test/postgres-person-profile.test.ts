import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { createSafeWrite } from "@studenthub/safe-write-contract";
import { ARABIC_LETTER_CODE_POINT_RANGES, OwnProfileRepository, UnconfiguredApprovedProfileAdapter, parseSelfEditValue, selfEditMaxValueLength, type SelfEditField } from "@studenthub/profile";
import { PostgresAuthzStore, PostgresPersonProfileStore, personRecordRef, runMigrations, safeWritePrincipalRef } from "@studenthub/db";

const URL=process.env.DATABASE_URL??"",KEY="shu372-postgres-test-secret-at-least-thirty-two-bytes";
let pool:pg.Pool,authz:PostgresAuthzStore,store:PostgresPersonProfileStore;
const people:string[]=[];
before(async()=>{if(!URL)throw new Error("DATABASE_URL is required for PostgreSQL person-profile tests");pool=new pg.Pool({connectionString:URL});await runMigrations(pool);authz=new PostgresAuthzStore(pool);store=new PostgresPersonProfileStore({pool});});
after(async()=>{for(const id of people)await pool.query("DELETE FROM principals WHERE id=$1",[id]);await pool.end();});
async function person(){const id=`shu372-${randomUUID()}`;people.push(id);await authz.registerPrincipal(createPrincipal({id,pbuuids:[],email:`${id}@example.invalid`}));return id;}
async function write(id:string,field:SelfEditField,input:string){const parsed=parseSelfEditValue(field,input);assert.ok(parsed.ok);const writer=createSafeWrite({store:store.forPrincipal(id),secret:KEY,policy:{allowed:[field],maxValueLength:selfEditMaxValueLength(field)}});const change={personRef:personRecordRef(id),field,value:parsed.value};const preview=await writer.preview({principalRef:safeWritePrincipalRef(id),change});assert.ok(preview.ok,JSON.stringify(preview));return writer.confirm({principalRef:safeWritePrincipalRef(id),change,token:preview.token});}

test("SHU372_WRITE migration runs, writes five fields atomically with value-free receipts, and owner deletion cascades",async()=>{
 const id=await person();for(const [field,value] of [["displayName","Ada Lovelace"],["arabicName","آدا لوفليس"],["objective","😀".repeat(100)],["intro","An introduction"],["preferredTime","Mornings"]] as const){const done=await write(id,field,value);assert.ok(done.ok,JSON.stringify(done));assert.deepEqual((await store.readReceipt(id,done.receipt.receiptRef))?.fields,[field]);const audit=await pool.query("SELECT before_summary,after_summary FROM authorization_mutation_audit WHERE request_ref=$1",[done.receipt.receiptRef]);assert.equal(JSON.stringify(audit.rows[0]).includes(value),false);}
 const row=(await pool.query("SELECT display_name,arabic_name,objective,introduction,preferred_time,display_name_updated_at,objective_updated_at,written_fields FROM person_profiles WHERE principal_id=$1",[id])).rows[0];assert.equal(row.display_name,"Ada Lovelace");assert.equal(row.objective,"😀".repeat(100));assert.ok(row.display_name_updated_at);assert.ok(row.objective_updated_at);assert.equal(row.written_fields.length,5);
 await pool.query("DELETE FROM principals WHERE id=$1",[id]);people.splice(people.indexOf(id),1);assert.equal((await pool.query("SELECT 1 FROM person_profiles WHERE principal_id=$1",[id])).rowCount,0);
});

test("SHU372_RULES database CHECK mirrors normalization, names, Arabic letters, forbidden points and code-point lengths",async()=>{const id=await person();const insert=(column:string,value:string)=>pool.query(`INSERT INTO person_profiles(principal_id,${column},written_fields) VALUES($1,$2,ARRAY['objective'])`,[id,value]);for(const [column,value] of [["display_name","One"],["display_name"," Two Names"],["arabic_name","Two Names"],["objective","x\u200b"],["objective","e\u0301"],["objective","😀".repeat(101)]] as const)await assert.rejects(insert(column,value),{code:"23514"},`${column} ${JSON.stringify(value)}`);await insert("objective","😀".repeat(100));});

test("SHU372_RULES PostgreSQL and the application agree on every Arabic-script letter code point",async()=>{
 const {rows}=await pool.query<{cp:number;ok:boolean}>(`SELECT cp,person_profile_arabic_letter(chr(cp)) AS ok FROM generate_series(1,1114111) cp WHERE cp NOT BETWEEN 55296 AND 57343`);
 const expected=(cp:number)=>ARABIC_LETTER_CODE_POINT_RANGES.some(([low,high])=>cp>=low&&cp<=high);
 assert.equal(rows.length,1_112_063);
 assert.deepEqual(rows.filter(({cp,ok})=>ok!==expected(cp)).slice(0,50),[]);
});

test("SHU372_OWNER another principal cannot read a receipt or address the written row",async()=>{const id=await person(),other=await person();const done=await write(id,"objective","Owned objective");assert.ok(done.ok);assert.equal(await store.readReceipt(other,done.receipt.receiptRef),null);assert.equal(await store.forPrincipal(other).readField(personRecordRef(id),"objective"),null);});

test("SHU372_OWNER a language receipt is unknown on the text receipt route",async()=>{const id=await person();const done=await write(id,"objective","Receipt source");assert.ok(done.ok);const ref=randomUUID().replaceAll("-","").repeat(2),token=randomUUID().replaceAll("-","").repeat(2);await pool.query(`INSERT INTO authorization_mutation_audit(request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary) SELECT $1,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,jsonb_set(jsonb_set(after_summary,'{fields}','["language"]'::jsonb),'{tokenRef}',to_jsonb($2::text)) FROM authorization_mutation_audit WHERE request_ref=$3`,[ref,token,done.receipt.receiptRef]);assert.equal(await store.readReceipt(id,ref),null);});

test("SHU372_PAGE clearing survives the real store read and OwnProfileRepository does not fall back to the snapshot",async()=>{const id=await person();assert.ok((await write(id,"objective","Written objective")).ok);assert.ok((await write(id,"objective","")).ok);const preferences=await store.readOwnPreferences(id);assert.ok(preferences);assert.equal((preferences as Record<string,unknown>).objective,null);assert.ok(((preferences as Record<string,unknown>).written_fields as string[]).includes("objective"));const repository=new OwnProfileRepository({principals:authz,source:new UnconfiguredApprovedProfileAdapter(),preferences:store});const result=await repository.readOwn({requesterPrincipalId:id,targetPersonId:id});assert.equal(result.kind,"found");if(result.kind==="found"){assert.equal(result.profile.fields.objective.state,"unavailable");if(result.profile.fields.objective.state==="unavailable")assert.equal(result.profile.fields.objective.reason,"not_recorded");}});
