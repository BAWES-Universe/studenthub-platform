import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import test from "node:test";

test("Q14_5_CATALOGUE migration keeps the closed kind check and area trigger",async()=>{const sql=await readFile(resolve("packages/db/migrations/0217_person_area.sql"),"utf8");assert.match(sql,/catalogue_items_catalogue_type_check/);assert.match(sql,/degree-group','area/);assert.match(sql,/enforce_catalogue_area_details_area/);});
test("Q14_5_PRIVATE events contain no coordinate columns",async()=>{const sql=await readFile(resolve("packages/db/migrations/0217_person_area.sql"),"utf8"),event=sql.slice(sql.indexOf("CREATE TABLE person_location_events"));assert.doesNotMatch(event,/latitude|longitude/);assert.match(sql,/person_locations_area_idx/);});
