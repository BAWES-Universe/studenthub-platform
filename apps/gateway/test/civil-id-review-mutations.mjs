import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source=await readFile(new URL("../src/civil-id-review-http.ts",import.meta.url),"utf8");
for(const needle of ["person===principal","[...reason].length>300","claim.revision!==row.revision","claim.expiresAt<=","req.headers.origin!==service.origin"]){
 assert.equal(source.split(needle).length-1,1,`mutation binding ${needle}`);
}
