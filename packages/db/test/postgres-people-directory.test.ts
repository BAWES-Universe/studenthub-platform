import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {after,before,beforeEach,test} from "node:test";
import pg from "pg";
import {runMigrations} from "../src/migrate.js";
import {classifyPeopleDirectorySearch,PostgresPeopleDirectoryStore} from "../src/postgres-people-directory-store.js";
import {classifySearchTerm} from "../../profile/src/people-directory.js";

test("DIRDB_SEARCH database and profile search classifiers stay identical",()=>{
  for(const value of ["c00123","+965 5000 0000","50000000","٥٠٠٠٠٠٠٠","00965-5000-0000","0000","123","+9(6)(5)(5)(0)(0)(0)(0)(0)(0)(0)(0)","https://studenthub.test/people/Noor_26",`Noor & | ! : * ( ) ' " < > نور`]){
    assert.deepEqual(classifyPeopleDirectorySearch(value),classifySearchTerm(value),`database classifier must mirror profile classifier for ${value}`);
  }
});

test("DIRDB_ONE one page is exactly one pool statement for zero, one, and sixty rows",async()=>{
  for(const count of [0,1,60]){
    let calls=0;
    const rows=Array.from({length:count},(_,index)=>({principalId:`p-${index}`}));
    const pool={query:async()=>{calls++;return{rows:[{total:count,rows}]}}} as unknown as pg.Pool;
    const store=new PostgresPeopleDirectoryStore({pool});
    assert.equal((await store.page({page:1},"2026-11-13")).rows.length,count);
    assert.equal(calls,1,`a directory page with ${count} rows must execute one statement and no per-row reads`);
  }
});

const URL=process.env.DATABASE_URL??"";let pool:pg.Pool,store:PostgresPeopleDirectoryStore;const ids:string[]=[];
before(async()=>{if(!URL)return;pool=new pg.Pool({connectionString:URL});await runMigrations(pool);store=new PostgresPeopleDirectoryStore({pool});});
beforeEach(async()=>{if(URL)await pool.query("TRUNCATE principals CASCADE");ids.length=0;});
after(async()=>{if(pool){await pool.query("TRUNCATE principals CASCADE");await pool.end();}});

async function person(values:{name:string;arabic?:string;universe?:string;phone?:string;handle?:string;candidate?:string}){
  const id=`shu618-${randomUUID()}`;ids.push(id);
  await pool.query("INSERT INTO principals(id,display_name,email) VALUES($1::text,$2::text,$3::text)",[id,values.universe??null,`${id}@test.invalid`]);
  await pool.query("INSERT INTO person_profiles(principal_id,display_name,display_name_written_at,arabic_name,arabic_name_written_at,phone,phone_written_at,profile_handle,profile_handle_written_at) VALUES($1::text,$2::text,clock_timestamp(),$3::text,CASE WHEN $3::text IS NULL THEN NULL ELSE clock_timestamp() END,$4::text,CASE WHEN $4::text IS NULL THEN NULL ELSE clock_timestamp() END,$5::text,CASE WHEN $5::text IS NULL THEN NULL ELSE clock_timestamp() END)",[id,values.name,values.arabic??null,values.phone??null,values.handle??null]);
  if(values.candidate)await pool.query("INSERT INTO legacy_account_links(principal_id,legacy_candidate_id,linked_by_ref,method) VALUES($1::text,$2::text,$3::text,'staff')",[id,values.candidate,randomBytes(32).toString("hex")]);
  return id;
}

async function catalogue(type:"country"|"area",name:string,code?:string){
  const id=randomUUID(),ref=randomBytes(32).toString("hex");
  await pool.query("INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,code,status,created_by_ref,updated_by_ref,created_at,updated_at) VALUES($1::uuid,$2::text,$3::text,$4::text,$5::text,'active',$6::text,$6::text,clock_timestamp(),clock_timestamp())",[id,type,name,`${name.toLowerCase()}-${id}`,code??null,ref]);
  return id;
}

let generatedPhone=0;
async function completePerson(label:string,options:{status?:"not_looking"|"active"|"open_to_offers"|null;nationality?:string;kuwaitiMother?:boolean|null;phone?:string}={}){
  const id=`shu618-${randomUUID()}`,country=options.nationality??await catalogue("country",`Country ${label}`,"US"),area=await catalogue("area",`Area ${label}`),now="2026-11-13T08:00:00Z";ids.push(id);
  await pool.query("INSERT INTO principals(id,display_name,email) VALUES($1::text,$2::text,$3::text)",[id,`Universe ${label}`,`${label}@test.invalid`]);
  await pool.query(`INSERT INTO person_profiles(principal_id,display_name,display_name_written_at,arabic_name,arabic_name_written_at,objective,objective_written_at,gender,gender_written_at,birth_date,birth_date_written_at,driving_licence,driving_licence_written_at,job_search_status,job_search_status_written_at,phone,phone_written_at,profile_handle,profile_handle_written_at,nationality_id,nationality_id_written_at,kuwaiti_mother,kuwaiti_mother_written_at)
    VALUES($1::text,$2::text,$3::timestamptz,'اسم كامل',$3::timestamptz,'Objective',$3::timestamptz,'female',$3::timestamptz,'2000-01-01',$3::timestamptz,false,$3::timestamptz,$4::text,CASE WHEN $4::text IS NULL THEN NULL ELSE $3::timestamptz END,$5::text,$3::timestamptz,$6::text,$3::timestamptz,$7::uuid,$3::timestamptz,$8::boolean,CASE WHEN $8::boolean IS NULL THEN NULL ELSE $3::timestamptz END)`,[id,`${label} Person`,now,options.status===undefined?"active":options.status,options.phone??`+9656${String(++generatedPhone).padStart(7,"0")}`,`h${randomBytes(5).toString("hex")}`,country,"kuwaitiMother" in options?options.kuwaitiMother:false]);
  await pool.query("INSERT INTO person_locations(principal_id,area_id,revision,written_at,updated_at) VALUES($1::text,$2::uuid,1,$3::timestamptz,$3::timestamptz)",[id,area,now]);
  await pool.query("INSERT INTO person_civil_ids(principal_id,country,number_ciphertext,number_hash,key_version,expiry_date,revision) VALUES($1::text,'KW',decode('01','hex'),decode($2::text,'hex'),1,'2030-01-01',1)",[id,randomBytes(32).toString("hex")]);
  for(const kind of ["education","skill"])await pool.query("INSERT INTO candidate_profile_records(id,owner_principal_id,kind,status,fields,created_at,updated_at) VALUES($1::uuid,$2::text,$3::text,'active','{}'::jsonb,$4::timestamptz,$4::timestamptz)",[randomUUID(),id,kind,now]);
  return id;
}

test("DIRDB_SEARCH Postgres searches names, employee id, normalized phone, suffix and handle",{skip:!URL},async()=>{
  const a=await person({name:"Noor Al Sabah",arabic:"نور الصباح",phone:"+96550000000",handle:"noor_618",candidate:"123"});
  const b=await person({name:"Other Person",universe:"Universe Sabah"});
  for(const q of ["noor","sabah","نور","C00123","c123","+965 5000 0000","50000000","٥٠٠٠٠٠٠٠","00965-5000-0000","0000","NOOR_618"]){const result=await store.page({q,page:1},"2026-11-13");assert.ok(result.rows.some(row=>(row as {principalId:string}).principalId===a),`search ${q}`);}
  assert.ok((await store.page({q:"universe",page:1},"2026-11-13")).rows.some(row=>(row as {principalId:string}).principalId===b));
  assert.equal((await store.page({q:"123",page:1},"2026-11-13")).rows.some(row=>(row as {principalId:string}).principalId===a),false,"short digits are not a phone search");
  const hostile=await store.page({q:`& | ! : * ( ) ' " < >`,page:1},"2026-11-13");
  assert.equal(hostile.total,0,"a term without usable tokens must safely match nobody");
});

test("DIRDB_SHOWN imported-only people remain visible with their Universe identity",{skip:!URL},async()=>{
  const id=`shu618-${randomUUID()}`;ids.push(id);
  await pool.query("INSERT INTO principals(id,display_name,email) VALUES($1::text,$2::text,$3::text)",[id,"Imported Universe",`${id}@test.invalid`]);
  await pool.query("INSERT INTO legacy_account_links(principal_id,legacy_candidate_id,linked_by_ref,method) VALUES($1::text,'987654321',$2::text,'staff')",[id,randomBytes(32).toString("hex")]);
  const result=await store.page({q:"imported",page:1},"2026-11-13");
  const row=result.rows.find(value=>value.principalId===id);
  assert.ok(row,"an imported snapshot must appear before a self-edit creates person_profiles");
  assert.equal(row.name,null);assert.equal(row.universeName,"Imported Universe");assert.equal(row.imported,true);
  assert.equal(row.employeeId,"C987654321","employee identifiers pad short ids but never truncate long ids");
});

test("DIRDB_FILTERS database filters all civil states, fields, paging, and stable shown-name order",{skip:!URL},async()=>{
  const country=await catalogue("country","Filterland","US"),reviewer=`shu618-reviewer-${randomUUID()}`;ids.push(reviewer);
  await pool.query("INSERT INTO principals(id) VALUES($1::text)",[reviewer]);
  const stateIds=new Map<string,string>();
  const statuses={none:"not_looking",waiting:"open_to_offers",rejected:"active",expired:"active",checked:"active",recorded:null} as const;
  for(const state of ["none","waiting","rejected","expired","checked","recorded"]){
    const id=await completePerson(`Civilcase ${state}`,{nationality:country,status:statuses[state as keyof typeof statuses]});stateIds.set(state,id);
    if(state==="none")await pool.query("UPDATE person_civil_ids SET released_at=clock_timestamp() WHERE principal_id=$1::text",[id]);
    if(state==="waiting")await pool.query("UPDATE person_civil_ids SET needs_review=true,expiry_date='2020-01-01' WHERE principal_id=$1::text",[id]);
    if(state==="expired")await pool.query("UPDATE person_civil_ids SET expiry_date='2020-01-01' WHERE principal_id=$1::text",[id]);
    if(state==="checked")await pool.query("UPDATE person_civil_ids SET expiry_date='2026-11-13' WHERE principal_id=$1::text",[id]);
    if(state==="rejected"||state==="checked")await pool.query("INSERT INTO civil_id_review_decisions(id,subject_principal_id,reviewer_principal_id,decision,reason,civil_revision,confirm_ref,decided_at) VALUES($1::uuid,$2::text,$3::text,$4::text,$5::text,1,$6::text,clock_timestamp())",[randomUUID(),id,reviewer,state==="rejected"?"rejected":"confirmed",state==="rejected"?"incorrect":null,randomBytes(32).toString("hex")]);
  }
  for(const [status,count] of [["unset",1],["not_looking",1],["open_to_offers",1],["active",3]] as const)assert.equal((await store.page({status,page:1},"2026-11-13")).total,count,`${status} status narrows without q`);
  assert.equal((await store.page({nationality:country,page:1},"2026-11-13")).total,6,"nationality narrows without q");
  for(const state of ["none","waiting","rejected","expired","checked","recorded"] as const)assert.deepEqual((await store.page({civil:state,page:1},"2026-11-13")).rows.map(row=>row.principalId),[stateIds.get(state)],`${state} civil filter narrows without q`);
  assert.equal((await store.page({details:"complete",page:1},"2026-11-13")).total,5,"details narrows without q");
  for(const state of ["none","waiting","rejected","expired","checked","recorded"]){
    const result=await store.page({q:"civilcase",civil:state as "none",page:1},"2026-11-13");
    assert.deepEqual(result.rows.map(row=>row.principalId),[stateIds.get(state)],`${state} civil filter and precedence`);
  }
  assert.deepEqual((await store.page({q:"civilcase",status:"unset",page:1},"2026-11-13")).rows.map(row=>row.principalId),[stateIds.get("recorded")],"unset status filter");
  assert.deepEqual((await store.page({q:"civilcase",status:"not_looking",page:1},"2026-11-13")).rows.map(row=>row.principalId),[stateIds.get("none")],"not-looking status filter");
  assert.deepEqual((await store.page({q:"civilcase",status:"open_to_offers",page:1},"2026-11-13")).rows.map(row=>row.principalId),[stateIds.get("waiting")],"open-to-offers status filter");
  assert.equal((await store.page({q:"civilcase",status:"active",page:1},"2026-11-13")).total,3,"active status filter");
  assert.equal((await store.page({q:"civilcase",nationality:country,page:1},"2026-11-13")).total,6,"nationality combines with q");
  assert.equal((await store.page({q:"civilcase",details:"complete",page:1},"2026-11-13")).total,5,"details filter combines with q and excludes the released civil record");

  for(let index=0;index<27;index++)await person({name:`Paged ${String.fromCharCode(97+Math.floor(index/26))}${String.fromCharCode(97+index%26)} Person`});
  const ties=[await person({name:"Paged Tie Person"}),await person({name:"Paged Tie Person"})].sort();
  const first=await store.page({q:"paged",page:1},"2026-11-13"),second=await store.page({q:"paged",page:2},"2026-11-13"),past=await store.page({q:"paged",page:3},"2026-11-13");
  assert.equal(first.rows.length,25,"page size is 25");assert.equal(second.rows.length,4);assert.deepEqual(past,{rows:[],total:29},"past-end page retains true total");
  const ordered=[...first.rows,...second.rows];assert.deepEqual(ordered.map(row=>row.name),[...ordered].map(row=>row.name).sort((a,b)=>String(a).localeCompare(String(b))),"pages use stable shown-name order");
  assert.deepEqual(ordered.filter(row=>row.name==="Paged Tie Person").map(row=>row.principalId),ties,"equal shown names use principal id as the stable tie-breaker");
});

test("DIRDB_DETAILS every SQL-covered requirement contributes exactly one missing detail",{skip:!URL},async()=>{
  const mutations:Record<string,(id:string)=>Promise<unknown>>={
    nationality:id=>pool.query("UPDATE person_profiles SET nationality_id=$2::uuid WHERE principal_id=$1::text",[id,randomUUID()]),
    display_name:id=>pool.query("UPDATE person_profiles SET display_name=NULL WHERE principal_id=$1::text",[id]),
    arabic_name:id=>pool.query("UPDATE person_profiles SET arabic_name=NULL WHERE principal_id=$1::text",[id]),
    gender:id=>pool.query("UPDATE person_profiles SET gender=NULL WHERE principal_id=$1::text",[id]),
    objective:id=>pool.query("UPDATE person_profiles SET objective=NULL WHERE principal_id=$1::text",[id]),
    email:id=>pool.query("UPDATE principals SET email=NULL WHERE id=$1::text",[id]),
    phone:id=>pool.query("UPDATE person_profiles SET phone=NULL WHERE principal_id=$1::text",[id]),
    birth_date:id=>pool.query("UPDATE person_profiles SET birth_date=NULL WHERE principal_id=$1::text",[id]),
    civil_id:id=>pool.query("UPDATE person_civil_ids SET country=NULL,number_ciphertext=NULL,number_hash=NULL,key_version=NULL WHERE principal_id=$1::text",[id]),
    civil_expiry:id=>pool.query("UPDATE person_civil_ids SET expiry_date=NULL WHERE principal_id=$1::text",[id]),
    driving_licence:id=>pool.query("UPDATE person_profiles SET driving_licence=NULL WHERE principal_id=$1::text",[id]),
    location:id=>pool.query("DELETE FROM person_locations WHERE principal_id=$1::text",[id]),
    kuwaiti_mother:id=>pool.query("UPDATE person_profiles SET kuwaiti_mother=NULL WHERE principal_id=$1::text",[id]),
    education:id=>pool.query("DELETE FROM candidate_profile_records WHERE owner_principal_id=$1::text AND kind='education'",[id]),
    skill:id=>pool.query("DELETE FROM candidate_profile_records WHERE owner_principal_id=$1::text AND kind='skill'",[id]),
  };
  const complete=await completePerson("Detail Complete");
  assert.equal((await store.page({q:"detail complete",details:"complete",page:1},"2026-11-13")).rows.find(row=>row.principalId===complete)?.detailsMissing,0,"all table-backed evidence is complete");
  for(const [key,mutate] of Object.entries(mutations)){
    const id=await completePerson(`Missing ${key.replaceAll("_","x")}`);await mutate(id);
    const row=(await store.page({q:"missing",details:"missing",page:1},"2026-11-13")).rows.find(value=>value.principalId===id);
    assert.equal(row?.detailsMissing,1,`${key} met/unmet SQL predicate agrees with one missing CMP requirement`);
  }
  const kw=await catalogue("country","Not named Kuwait","KW"),kwPerson=await completePerson("Kuwaiti Code",{nationality:kw,kuwaitiMother:null});
  assert.equal((await store.page({q:"kuwaiti code",page:1},"2026-11-13")).rows.find(row=>row.principalId===kwPerson)?.detailsMissing,0,"Kuwaiti-mother is waived by KW code, never country name");
  const noAnswers=await completePerson("Stored No",{kuwaitiMother:false});
  assert.equal((await store.page({q:"stored no",page:1},"2026-11-13")).rows.find(row=>row.principalId===noAnswers)?.detailsMissing,0,"stored No answers are complete");
});

test("DIRDB_SHOWN database row contains the bounded staff projection",{skip:!URL},async()=>{
  const country=await catalogue("country","Shown Country","US"),id=await completePerson("Shown Person",{status:"open_to_offers",nationality:country,phone:"+96550001234"});
  const reviewer=`shu618-shown-reviewer-${randomUUID()}`;ids.push(reviewer);
  await pool.query("INSERT INTO principals(id) VALUES($1::text)",[reviewer]);
  await pool.query("INSERT INTO civil_id_review_decisions(id,subject_principal_id,reviewer_principal_id,decision,reason,civil_revision,confirm_ref,decided_at) VALUES($1::uuid,$2::text,$3::text,'confirmed',NULL,1,$4::text,clock_timestamp())",[randomUUID(),id,reviewer,randomBytes(32).toString("hex")]);
  await pool.query("INSERT INTO legacy_account_links(principal_id,legacy_candidate_id,linked_by_ref,method) VALUES($1::text,'618',$2::text,'staff')",[id,randomBytes(32).toString("hex")]);
  const row=(await store.page({q:"shown",page:1},"2026-11-13")).rows.find(value=>value.principalId===id);assert.ok(row);
  assert.deepEqual(row,{principalId:id,name:"Shown Person Person",universeName:"Universe Shown Person",arabicName:"اسم كامل",workStatus:"open_to_offers",nationality:{id:country,name:"Shown Country"},detailsMissing:0,civilState:"checked",imported:true,employeeId:"C00618",phoneLast4:"1234"},"row shows every allowed field including the civil decision and only the phone's final four digits");
});

test("DIRDB_ONE migration creates only the required directory indexes",{skip:!URL},async()=>{
  const names=(await pool.query<{indexname:string}>("SELECT indexname FROM pg_indexes WHERE indexname=ANY($1::text[])",[["person_profiles_job_search_status_idx","person_profiles_names_search_idx","principals_display_name_search_idx","person_profiles_phone_reversed_idx","person_civil_ids_active_expiry_idx","civil_id_review_decisions_current_revision_idx"]])).rows.map(r=>r.indexname);
  assert.equal(names.length,6,"all directory indexes must exist");
  const extensions=await pool.query("SELECT extname FROM pg_extension WHERE extname NOT IN ('plpgsql')");
  assert.equal(extensions.rows.length,0,"directory migration must create no extension");
});
