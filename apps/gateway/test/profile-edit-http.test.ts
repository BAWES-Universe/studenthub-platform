import assert from "node:assert/strict";
import test from "node:test";
import { shorten } from "../src/profile-edit-http.js";
test("SHU372_PAGE preview shortening does not split code points",()=>{const value="😀".repeat(121);assert.equal([...shorten(value)].length,121);assert.equal(shorten(value),"😀".repeat(120)+"…")});
