import assert from "node:assert/strict";
import test from "node:test";
import { parseSelfEditValue, SELF_EDIT_FIELDS } from "../src/self-edit.js";

test("SHU372_RULES text limits match the profile projection and names require two words",()=>{
  assert.deepEqual(SELF_EDIT_FIELDS,["display_name","arabic_name","objective","intro","preferred_time"]);
  assert.equal(parseSelfEditValue("display_name","Synthetic Person"),"Synthetic Person");
  assert.equal(parseSelfEditValue("arabic_name","شخص تجريبي"),"شخص تجريبي");
  assert.throws(()=>parseSelfEditValue("display_name","Single"));
  assert.equal(parseSelfEditValue("intro","x".repeat(5000)).length,5000);
  assert.throws(()=>parseSelfEditValue("objective","x".repeat(101)));
});
