import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source=await readFile(new URL("../dist/completeness.js",import.meta.url),"utf8");
for(const needle of ['evidence.nationalityCode !== "KW"','d.type === "personal-photo"','value.length === 0'])
  assert.equal(source.split(needle).length-1,1,`Q14_4 mutation binding ${needle}`);
