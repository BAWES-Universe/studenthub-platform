import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { PostgresPersonCivilIdStore } from "../src/postgres-person-civil-id-store.js";
import { runMigrations } from "../src/migrate.js";
import { CivilIdVault, createCivilId } from "../../profile/src/civil-id.js";

const DB_URL=process.env.DATABASE_URL??"", P="civil-person-p", Q="civil-person-q";let pool:pg.Pool;
before(async()=>{if(!DB_URL)throw new Error("DATABASE_URL is required for PostgreSQL civil-ID tests");pool=new pg.Pool({connectionString:DB_URL});await runMigrations(pool);});
beforeEach(async()=>{await pool.query("TRUNCATE person_civil_id_events,person_civil_ids RESTART IDENTITY CASCADE");await pool.query("DELETE FROM principals WHERE id=ANY($1::text[])",[[P,Q]]);await pool.query("INSERT INTO principals(id) VALUES($1::text),($2::text)",[P,Q]);});
after(async()=>pool.end());
const vault=new CivilIdVault(Buffer.alloc(32,8));
const service=()=>createCivilId({store:new PostgresPersonCivilIdStore({pool}),vault,clock:{now:()=>new Date("2026-01-01T00:00:00Z")}});

test("Q14_3_POSTGRES migration pins secrecy uniqueness and checks",async()=>{const sql=await readFile(new URL("../migrations/0216_person_civil_id.sql",import.meta.url),"utf8");assert.match(sql,/octet_length\(number_hash\)=32/);assert.match(sql,/UNIQUE INDEX person_civil_ids_active_number/);assert.match(sql,/released_at IS NULL/);assert.doesNotMatch(sql,/authorization_audit_summary_valid/);const events=sql.slice(sql.indexOf("CREATE TABLE person_civil_id_events"));assert.doesNotMatch(events,/ciphertext|number_hash/);});

test("Q14_3_UNIQUE Postgres refuses duplicate at commit, permits release and re-recording, and scopes hashes by country",async()=>{const a=service(),b=service();const results=await Promise.all([a.save({principalId:P,submissionId:"00000000-0000-4000-8000-000000000101",revision:0,country:"KW",number:"290010100000",expiry:""}),b.save({principalId:Q,submissionId:"00000000-0000-4000-8000-000000000102",revision:0,country:"KW",number:"290010100000",expiry:""})]);assert.equal(results.filter(x=>x.ok).length,1);const owner=results[0]!.ok?P:Q,other=owner===P?Q:P;await service().release(owner);assert.equal((await service().save({principalId:other,submissionId:"00000000-0000-4000-8000-000000000103",revision:0,country:"KW",number:"290010100000",expiry:""})).ok,true);await service().release(other);assert.equal((await service().save({principalId:other,submissionId:"00000000-0000-4000-8000-000000000106",revision:0,country:"BH",number:"123456789",expiry:""})).ok,true);assert.equal((await service().readOwn(other))?.maskedNumber,"••••• 6789");});

test("Q14_3_REVIEW_FLAG Postgres changes review atomically and replay wins over stale revision",async()=>{const s=service(),id="00000000-0000-4000-8000-000000000104";assert.equal((await s.save({principalId:P,submissionId:id,revision:0,country:"KW",number:"290010100001",expiry:"2027-01-01"})).ok,true);const row=await pool.query("SELECT needs_review,revision FROM person_civil_ids WHERE principal_id=$1::text",[P]);assert.deepEqual(row.rows[0],{needs_review:true,revision:1});assert.deepEqual(await s.save({principalId:P,submissionId:id,revision:0,country:"KW",number:"290010100001",expiry:"2027-01-01"}),{ok:false,reason:"submission_reused"});assert.equal((await pool.query("SELECT count(*)::int n FROM person_civil_id_events WHERE principal_id=$1::text",[P])).rows[0].n,1);});

test("Q14_3_SECRECY Postgres events contain no number and ordinary reads expose no sealed material",async()=>{const s=service();await s.save({principalId:P,submissionId:"00000000-0000-4000-8000-000000000105",revision:0,country:"KW",number:"290010100009",expiry:""});const store=new PostgresPersonCivilIdStore({pool}),read=await store.read(P);assert.equal((read as unknown as Record<string,unknown>).sealed,undefined);assert.equal(read?.maskedNumber,"•••• •••• 0009");assert.equal(await store.decryptNumber(P,vault),"290010100009");const event=JSON.stringify((await pool.query("SELECT * FROM person_civil_id_events WHERE principal_id=$1::text",[P])).rows);assert.doesNotMatch(event,/290010100009/);});
