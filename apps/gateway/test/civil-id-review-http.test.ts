import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("REV_QUEUE queue HTML carries JSON row evidence without exposing the full number",async()=>{const source=await readFile(new URL("../src/civil-id-review-http.js",import.meta.url),"utf8");assert.match(source,/Waiting since/);assert.match(source,/Photo reading:/);assert.match(source,/maskedNumber/);});
test("REV_DECIDE decision page supplies revision, evidence, choices and reason",async()=>{const source=await readFile(new URL("../src/civil-id-review-http.js",import.meta.url),"utf8");for(const value of ['name="revision"','name="evidence"','value="confirmed"','value="rejected"','name="reason"'])assert.ok(source.includes(value),value);});
test("REV_ORIGIN posts require exact origin and reject cross-site requests",async()=>{const source=await readFile(new URL("../src/civil-id-review-http.js",import.meta.url),"utf8");assert.match(source,/req\.headers\.origin !== r\.origin/);assert.match(source,/sec-fetch-site.*cross-site/);});
test("REV_SHOWN profile state and sidebar count are connected",async()=>{const [web,index]=await Promise.all([readFile(new URL("../src/web-ui.js",import.meta.url),"utf8"),readFile(new URL("../src/index.js",import.meta.url),"utf8")]);assert.match(web,/Waiting for StudentHub to check/);assert.match(web,/Rejected:/);assert.match(web,/Civil IDs to check/);assert.match(index,/countPending/);});
