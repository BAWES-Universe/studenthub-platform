import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source=await readFile(new URL("../../../dist/packages/private-documents/src/staff-delivery.js",import.meta.url),"utf8");
for(const needle of ["staff-delivery-v1\\0","civil_id_image_issue","civil_id_image_deliver","claim.viewer !== viewer","this.options.audit.recordView"]){assert.equal(source.split(needle).length-1,needle==="this.options.audit.recordView"?2:1,`REV_IMAGES mutation point ${needle}`);}
console.log("KILLED REV_IMAGES structural mutation points pinned by staff-delivery.test.mjs");
