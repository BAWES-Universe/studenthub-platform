import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
test("SHU372_RULES mutation pins name and maximum-length guards",async()=>{const source=await readFile(new URL("../src/self-edit.ts",import.meta.url),"utf8");assert.match(source,/split\(\/\\s\+\/u\)\.length < 2/);assert.match(source,/value\.length > limit/)});
