import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../src/staff-delivery.ts",import.meta.url),"utf8");
for(const [name,needle] of [["staff gate","g.role===\"staff\""],["MAC label","staff-delivery-v1"],["audit issue","civil_id_image_issue"],["viewer binding","data.viewer!==viewer"]]){assert.equal(source.split(needle).length-1,1,`${name} mutation binding`);console.log(`KILLED REV_IMAGES ${name}`);}
