import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source=await readFile(new URL("../dist/completeness.js",import.meta.url),"utf8");
for(const needle of ['nationalityCode !== "KW"','documents.has("personal-photo")','missing.length === 0'])
  assert.equal(source.split(needle).length,2,`Q14_4_RULES mutation point ${needle}`);
