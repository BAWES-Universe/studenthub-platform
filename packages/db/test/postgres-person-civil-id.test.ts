import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
test("Q14_3_POSTGRES migration pins secrecy uniqueness and checks",async()=>{const sql=await readFile(new URL("../../../../packages/db/migrations/0216_person_civil_id.sql",import.meta.url),"utf8");assert.match(sql,/octet_length\(number_hash\)=32/);assert.match(sql,/UNIQUE INDEX person_civil_ids_active_number/);assert.match(sql,/released_at IS NULL/);assert.doesNotMatch(sql,/authorization_audit_summary_valid/);const events=sql.slice(sql.indexOf("CREATE TABLE person_civil_id_events"));assert.doesNotMatch(events,/ciphertext|number_hash/);});
