import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
const migration=new URL("../../../../packages/db/migrations/0215_legacy_account_links.sql",import.meta.url);
const store=new URL("../../../../packages/db/src/postgres-legacy-link-store.ts",import.meta.url);
test("Q14_L_LINK migration makes link and event a constrained audited pair",async()=>{const sql=await readFile(migration,"utf8");assert.match(sql,/legacy_account_links/);assert.match(sql,/legacy_account_link_events/);assert.match(sql,/actor_ref char\(64\)/);assert.doesNotMatch(sql,/password|token|email|phone|name/i);});
test("Q14_L_UNIQUE database enforces both sides and transaction source writes the event",async()=>{const sql=await readFile(migration,"utf8");assert.match(sql,/principal_id TEXT PRIMARY KEY/);assert.match(sql,/legacy_candidate_id TEXT NOT NULL UNIQUE/);const source=await readFile(store,"utf8");assert.match(source,/BEGIN/);assert.match(source,/legacy_account_link_events/);assert.match(source,/COMMIT/);});
test("Q14_L_REFUSALS counter is one atomic upsert and locks at five",async()=>{const source=await readFile(store,"utf8");assert.match(source,/INSERT INTO legacy_link_attempts[\s\S]*ON CONFLICT[\s\S]*failures \+ 1::integer/);assert.match(source,/>= 5::integer/);assert.doesNotMatch(source,/SELECT failures/);});
test("Q14_L_KEYS schema stores immutable keys only and resolve uses principal primary key",async()=>{const sql=await readFile(migration,"utf8");const table=/CREATE TABLE legacy_account_links \(([\s\S]*?)\);/.exec(sql)?.[1]??"";assert.doesNotMatch(table,/email|phone|name/i);const source=await readFile(store,"utf8");assert.match(source,/WHERE principal_id = \$1::text/);assert.doesNotMatch(source,/WHERE email/);});
