import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("Q14_5_MUTATIONS required semantic needles are uniquely bound",async()=>{const area=await readFile(new URL("../dist/area.js",import.meta.url),"utf8"),profile=await readFile(new URL("../dist/profile.js",import.meta.url),"utf8"),gateway=await readFile(new URL("../../../dist/apps/gateway/src/area-http.js",import.meta.url),"utf8");for(const [source,needle]of [[area,"bestDistance <= 50"],[profile,'preferences.language === "ar"'],[gateway,"request.headers.origin !== origin"],[gateway,"script-src 'nonce-${nonce}'"],[gateway,'location: "/profile#field-area"']])assert.equal(source.split(needle).length-1,1,needle)});
