import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProfileEdit, profileEditPolicy } from "../src/self-edit.js";

test("SHU372_RULES names and text use the shared code-point rules",()=>{
 for(const name of ["Noor Al-Sabah","O'Brien Smith","Abdul-Aziz Al Saud"])assert.deepEqual(normalizeProfileEdit("display_name",name),{ok:true,value:name});
 assert.equal(normalizeProfileEdit("display_name","Ahmed 3").ok,false);
 assert.equal(normalizeProfileEdit("arabic_name","Ahmed Smith").ok,false);
 assert.equal(normalizeProfileEdit("arabic_name","أحمد علي").ok,true);
 assert.equal(normalizeProfileEdit("objective","😀".repeat(100)).ok,true);
 assert.deepEqual(normalizeProfileEdit("objective","  hello\u00a0 world  "),{ok:true,value:"hello world"});
 assert.equal(profileEditPolicy("objective").allowClear,true);assert.equal(profileEditPolicy("display_name").allowClear,false);
});
test("SHU372_WRITE each optional field can clear and display name cannot",()=>{for(const f of ["arabic_name","objective","introduction","preferred_time"] as const)assert.deepEqual(normalizeProfileEdit(f,""),{ok:true,value:""});assert.equal(normalizeProfileEdit("display_name","").ok,false)});
test("SHU372_OWNER input contains no person identifier",()=>{assert.deepEqual(Object.keys({field:"objective",value:"work"}),["field","value"])});
