import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {after,before,test} from "node:test";
import pg from "pg";
import {runMigrations} from "../src/migrate.js";
import {PostgresPeopleDirectoryStore} from "../src/postgres-people-directory-store.js";

test("DIRDB_ONE one page is exactly one pool statement even when empty",async()=>{
  let calls=0;
  const pool={query:async()=>{calls++;return{rows:[{total:0,rows:[]}]}}} as unknown as pg.Pool;
  const store=new PostgresPeopleDirectoryStore({pool});
  assert.deepEqual(await store.page({page:1},"2026-11-13"),{rows:[],total:0});
  assert.equal(calls,1,"a directory page must execute one statement");
});

const URL=process.env.DATABASE_URL??"";let pool:pg.Pool,store:PostgresPeopleDirectoryStore;const ids:string[]=[];
before(async()=>{if(!URL)return;pool=new pg.Pool({connectionString:URL});await runMigrations(pool);store=new PostgresPeopleDirectoryStore({pool});});
after(async()=>{if(pool){if(ids.length)await pool.query("DELETE FROM principals WHERE id=ANY($1::text[])",[ids]);await pool.end();}});

async function person(values:{name:string;arabic?:string;universe?:string;phone?:string;handle?:string;candidate?:string}){
  const id=`shu618-${randomUUID()}`;ids.push(id);
  await pool.query("INSERT INTO principals(id,display_name,email) VALUES($1::text,$2::text,$3::text)",[id,values.universe??null,`${id}@test.invalid`]);
  await pool.query("INSERT INTO person_profiles(principal_id,display_name,display_name_written_at,arabic_name,arabic_name_written_at,phone,phone_written_at,profile_handle,profile_handle_written_at) VALUES($1::text,$2::text,clock_timestamp(),$3::text,CASE WHEN $3::text IS NULL THEN NULL ELSE clock_timestamp() END,$4::text,CASE WHEN $4::text IS NULL THEN NULL ELSE clock_timestamp() END,$5::text,CASE WHEN $5::text IS NULL THEN NULL ELSE clock_timestamp() END)",[id,values.name,values.arabic??null,values.phone??null,values.handle??null]);
  if(values.candidate)await pool.query("INSERT INTO legacy_account_links(principal_id,legacy_candidate_id,linked_by_ref,method) VALUES($1::text,$2::text,$3::text,'staff')",[id,values.candidate,randomBytes(32).toString("hex")]);
  return id;
}

test("DIRDB_SEARCH Postgres searches names, employee id, normalized phone, suffix and handle",{skip:!URL},async()=>{
  const a=await person({name:"Noor Al Sabah",arabic:"نور الصباح",phone:"+96550000000",handle:"noor_618",candidate:"123"});
  const b=await person({name:"Other Person",universe:"Universe Sabah"});
  for(const q of ["noor","sabah","نور","C00123","c123","+965 5000 0000","50000000","٥٠٠٠٠٠٠٠","00965-5000-0000","0000","NOOR_618"]){const result=await store.page({q,page:1},"2026-11-13");assert.ok(result.rows.some(row=>(row as {principalId:string}).principalId===a),`search ${q}`);}
  assert.ok((await store.page({q:"universe",page:1},"2026-11-13")).rows.some(row=>(row as {principalId:string}).principalId===b));
  assert.equal((await store.page({q:"123",page:1},"2026-11-13")).rows.some(row=>(row as {principalId:string}).principalId===a),false,"short digits are not a phone search");
  assert.doesNotThrow(async()=>store.page({q:`& | ! : * ( ) ' " < >`,page:1},"2026-11-13"));
});

test("DIRDB_ONE migration creates only the required directory indexes",{skip:!URL},async()=>{
  const names=(await pool.query<{indexname:string}>("SELECT indexname FROM pg_indexes WHERE indexname=ANY($1::text[])",[["person_profiles_job_search_status_idx","person_profiles_names_search_idx","principals_display_name_search_idx","person_profiles_phone_reversed_idx","person_civil_ids_active_expiry_idx","civil_id_review_decisions_current_revision_idx"]])).rows.map(r=>r.indexname);
  assert.equal(names.length,6,"all directory indexes must exist");
  const extensions=await pool.query("SELECT extname FROM pg_extension WHERE extname NOT IN ('plpgsql')");
  assert.equal(extensions.rows.length,0,"directory migration must create no extension");
});
