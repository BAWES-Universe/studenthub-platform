import assert from "node:assert/strict";
import test from "node:test";
import { isCatalogueType } from "@studenthub/reference-catalogue";
import { nearestArea, validateCoordinates } from "@studenthub/profile";
import { readFile } from "node:fs/promises";

test("Q14_5_CATALOGUE area joins the ten established kinds",()=>{for(const kind of ["country","currency","bank","tag","brand","mall","university","major","degree","degree-group","area"])assert.equal(isCatalogueType(kind),true);assert.equal(isCatalogueType("unknown"),false)});
test("Q14_5_PAGE area HTTP pins strict origin, private POST coordinates, nonce CSP and redirect",async()=>{const source=await readFile(new URL("../src/area-http.js",import.meta.url),"utf8");assert.match(source,/request\.headers\.origin\s*!==\s*origin/);assert.doesNotMatch(source,/\?latitude|URLSearchParams\([^)]*latitude/);assert.match(source,/script-src 'nonce-\$\{nonce\}'/);assert.match(source,/location:\s*"\/profile#field-area"/);assert.match(source,/Unknown form field/)});
test("Q14_5_PRIVATE events and redirects contain no coordinate values",async()=>{const migration=await readFile("packages/db/migrations/0217_person_area.sql","utf8");const events=migration.slice(migration.indexOf("CREATE TABLE person_location_events"));assert.doesNotMatch(events,/latitude|longitude/);assert.deepEqual(validateCoordinates(null,null),{latitude:null,longitude:null})});
test("Q14_5_COORDINATES suggestion remains confirmation-only and capped",()=>{assert.equal(nearestArea([{id:"x",nameEn:"X",latitude:0,longitude:0}],1,1),null)});
