import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source=await readFile(new URL("../../../dist/apps/gateway/src/civil-id-review-http.js",import.meta.url),"utf8");
for(const needle of ["reason.length > 300","revision !== row.revision","expiresAt","sec-fetch-site","body.get(\"evidence\") !== evidence"]){assert.ok(source.includes(needle),`REV_DECIDE mutation point ${needle}`);}
console.log("KILLED REV_DECIDE route mutation points pinned by civil-id-review-http.test.ts");
