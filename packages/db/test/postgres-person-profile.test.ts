import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("SHU372_WRITE migration pins owner cascade, five columns, per-field dates, and receipt fields",async()=>{
 const sql=await readFile("packages/db/migrations/0211_person_profiles.sql","utf8");
 assert.match(sql,/principal_id TEXT PRIMARY KEY REFERENCES principals\(id\) ON DELETE CASCADE/);
 for(const name of ["display_name","arabic_name","objective","introduction","preferred_time"]) {assert.match(sql,new RegExp(`\\b${name} TEXT`));assert.match(sql,new RegExp(`\\b${name}_updated_at TIMESTAMPTZ`));}
 assert.match(sql,/"displayName".*"arabicName".*"objective".*"intro".*"preferredTime"/s);
});

test("SHU372_RULES migration uses the 0183 Unicode predicate and code-point length",async()=>{const sql=await readFile("packages/db/migrations/0211_person_profiles.sql","utf8");assert.match(sql,/candidate_beneficiary_name_valid/);assert.match(sql,/char_length\(value\)/);assert.match(sql,/arabic_name.*\\u0600/s);});
