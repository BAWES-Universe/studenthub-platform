import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("REV_ORIGIN mutation guards are compiled",async()=>{const s=await readFile(new URL("../../../dist/apps/gateway/src/civil-id-review-http.js",import.meta.url),"utf8");for(const needle of ['req.headers.origin !== rt.origin','req.headers["sec-fetch-site"] === "cross-site"','p.revision !== row.revision'])assert.equal(s.split(needle).length-1,1,needle);});
