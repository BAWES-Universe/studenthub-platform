import assert from "node:assert/strict";
import test from "node:test";
import { parseSelfEditValue, SELF_EDIT_CLEAR } from "../src/self-edit.js";

test("SHU372_RULES normalises whitespace, counts code points, requires two names and an Arabic letter", () => {
  assert.deepEqual(parseSelfEditValue("displayName", "  Ada\u00a0Lovelace  "), {ok:true,value:"Ada Lovelace",cleared:false});
  assert.equal(parseSelfEditValue("displayName", "Ada").ok, false);
  assert.equal(parseSelfEditValue("arabicName", "Ada Lovelace").ok, false);
  assert.equal(parseSelfEditValue("arabicName", "Ada ، Lovelace").ok, false);
  assert.equal(parseSelfEditValue("arabicName", "آدا لوفليس").ok, true);
  assert.equal(parseSelfEditValue("objective", "😀".repeat(100)).ok, true);
  assert.equal(parseSelfEditValue("objective", "😀".repeat(101)).ok, false);
  assert.equal(parseSelfEditValue("intro", "x\u200b y").ok, false);
});

test("SHU372_WRITE an empty value has an explicit clear representation", () => {
  assert.deepEqual(parseSelfEditValue("intro", ""), {ok:true,value:SELF_EDIT_CLEAR,cleared:true});
  assert.equal(parseSelfEditValue("intro", SELF_EDIT_CLEAR).ok, false, "the clear marker cannot be typed as a value");
});
