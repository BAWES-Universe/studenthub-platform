import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("Q14_5_CATALOGUE migration replaces guarded CHECK and area trigger",async()=>{const sql=await readFile("packages/db/migrations/0217_person_area.sql","utf8");assert.match(sql,/catalogue_items_catalogue_type_check/);assert.match(sql,/ten-kind/);assert.match(sql,/catalogue_type = 'area'/);assert.match(sql,/catalogue_area_details_area/)});
test("Q14_5_PRIVATE transaction locks, validates active area, indexes lookup and records no coordinates",async()=>{const source=await readFile("dist/packages/db/src/postgres-person-location-store.js","utf8");assert.match(source,/FOR UPDATE/);assert.match(source,/catalogue_type='area' AND status='active'/);assert.match(source,/submission_id=\$2::uuid/);const sql=await readFile("packages/db/migrations/0217_person_area.sql","utf8");assert.match(sql,/person_locations_area_idx/);const events=sql.slice(sql.indexOf("CREATE TABLE person_location_events"));assert.doesNotMatch(events,/latitude|longitude/)});
