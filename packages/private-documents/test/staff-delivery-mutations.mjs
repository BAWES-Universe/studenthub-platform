import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("REV_IMAGES mutation needles remain bound",async()=>{const s=await readFile(new URL("../../../dist/packages/private-documents/src/staff-delivery.js",import.meta.url),"utf8");for(const needle of ["staff-delivery-v1","recordView","claim.viewer !== viewer"])assert.ok(s.includes(needle),needle);});
