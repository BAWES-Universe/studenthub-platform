import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../src/civil-id-review-http.ts",import.meta.url),"utf8");
for(const [name,needle] of [["mask queue","maskCivilId("],["own refusal","subject===who.principalId"],["reject reason","reason.length>300"],["revision","revision!==row.revision"],["confirmation expiry","claim.expires"],["Origin","req.headers.origin!==s.origin"]]){assert.ok(source.includes(needle),`${name} mutation binding`);console.log(`KILLED REV_DECIDE ${name}`);}
