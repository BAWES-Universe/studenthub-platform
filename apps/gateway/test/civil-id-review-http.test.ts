import assert from "node:assert/strict";
import test from "node:test";
import { renderCivilIdRow } from "../src/civil-id-http.js";
import { ROUTES } from "../src/routes/index.js";

test("REV_SHOWN decision states render once in the Civil ID row with escaped reasons and both fixes",()=>{
  const checked=renderCivilIdRow("en",{country:"KW",maskedNumber:"•••• •••• 1234",expiry:"2027-01-01",needsReview:false},{state:"checked"});
  assert.match(checked,/id="field-civilId" class="p-row"/,"REV_SHOWN state stays inside the Civil ID row");
  assert.equal((checked.match(/Checked/g)??[]).length,1,"REV_SHOWN one decision state per render");
  const rejected=renderCivilIdRow("en",null,{state:"rejected",reason:"Wrong <photo>"});
  assert.match(rejected,/Rejected: Wrong &lt;photo&gt;/,"REV_SHOWN rejection reason is escaped");
  assert.match(rejected,/href="\/profile\/civil-id"/,"REV_SHOWN rejected details can be fixed");
  assert.match(rejected,/href="\/profile\/documents"/,"REV_SHOWN rejected photos can be fixed");
});

test("REV_SHOWN waiting remains compatible with the CIV projection and Arabic copy",()=>{
  const en=renderCivilIdRow("en",{country:"KW",maskedNumber:"•••• •••• 1234",expiry:null,needsReview:true});
  const ar=renderCivilIdRow("ar",{country:"KW",maskedNumber:"•••• •••• 1234",expiry:null,needsReview:true});
  assert.equal((en.match(/Waiting for StudentHub to check/g)??[]).length,1,"REV_SHOWN waiting renders exactly once");
  assert.match(ar,/بانتظار تحقق StudentHub/,"REV_SHOWN waiting has Arabic copy");
});

test("REV_STAFF review HTTP is in the ordered real gateway route list",()=>{
  assert.equal(ROUTES.filter(route=>route.name==="civil-id-review").length,1,"REV_STAFF route is registered exactly once");
});
