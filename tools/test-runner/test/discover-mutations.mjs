import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../discover.mjs", import.meta.url), "utf8");
assert.match(source, /baseline tests missing/);
console.log("SHU370_FAILS_CLOSED mutation guard passed");
