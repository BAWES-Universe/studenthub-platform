import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source=await readFile(new URL("../../../dist/apps/gateway/src/civil-id-review-http.js",import.meta.url),"utf8");
for(const [token,needle] of [["REV_QUEUE","listPending"],["REV_STAFF","id === viewer"],["REV_DECIDE","outcome === \"stale\""],["REV_IMAGES","civil_id_page"],["REV_SECRECY","maskNumber"],["REV_ORIGIN","req.headers.origin !== svc.origin"]])assert.equal(source.split(needle).length,2,`${token} mutation binding`);
