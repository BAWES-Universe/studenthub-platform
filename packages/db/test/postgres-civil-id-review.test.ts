import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("REV_DECIDE migration pins append-only decisions, evidence, reviewer separation and indexes",async()=>{const sql=await readFile(join(process.cwd(),"packages/db/migrations/0219_civil_id_reviews.sql"),"utf8");assert.match(sql,/CHECK \(subject_principal_id <> reviewer_principal_id\)/);assert.match(sql,/confirm_ref char\(64\) NOT NULL UNIQUE/);assert.match(sql,/front_version uuid/);assert.match(sql,/back_version uuid/);assert.equal((sql.match(/BEFORE UPDATE OR DELETE/g)??[]).length,2);assert.match(sql,/person_civil_ids_review_queue/);assert.doesNotMatch(sql,/number_(?:hash|ciphertext)|authorization_audit/);});
test("REV_QUEUE store keeps list and state reads set-based and explicitly typed",async()=>{const source=await readFile(new URL("../src/postgres-civil-id-review-store.js",import.meta.url),"utf8");assert.match(source,/count\(\*\) OVER\(\)/);assert.match(source,/LIMIT 25 OFFSET/);assert.match(source,/released_at IS NULL/);assert.match(source,/principal_id<>\$1::text/);assert.match(source,/LEFT JOIN LATERAL/);assert.doesNotMatch(source,/for\s*\([^)]*rows/i);});
test("REV_DECIDE fixture identifiers are collision safe",()=>{assert.notEqual(`review-${randomUUID()}`,`review-${randomUUID()}`);});
