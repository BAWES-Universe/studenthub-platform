import assert from "node:assert/strict";
import test from "node:test";
import { parseSelfEditInput, parseSelfEditValue, SELF_EDIT_CLEAR, SELF_EDIT_FIELDS } from "../src/self-edit.js";
import { InMemoryAuthzStore, createPrincipal } from "@studenthub/contracts";
import { InMemoryApprovedProfileAdapter, OwnProfileRepository, SYNTHETIC_PROFILE_FIXTURES } from "../src/index.js";

test("SHU372_RULES text limits match the profile projection and names require two words",()=>{
  assert.deepEqual(SELF_EDIT_FIELDS,["display_name","arabic_name","objective","intro","preferred_time"]);
  assert.equal(parseSelfEditValue("display_name","Synthetic Person"),"Synthetic Person");
  assert.equal(parseSelfEditValue("arabic_name","شخص تجريبي"),"شخص تجريبي");
  assert.throws(()=>parseSelfEditValue("display_name","Single"));
  assert.equal(parseSelfEditValue("intro","x".repeat(5000)).length,5000);
  assert.throws(()=>parseSelfEditValue("objective","x".repeat(101)));
  assert.throws(()=>parseSelfEditValue("display_name","  Ada Lovelace  "));
  assert.throws(()=>parseSelfEditValue("objective","safe\u202Espoof"));
  assert.throws(()=>parseSelfEditValue("arabic_name","John Smith"));
  assert.equal(parseSelfEditInput("objective",""),SELF_EDIT_CLEAR);
  assert.throws(()=>parseSelfEditInput("display_name",""));
  assert.equal(parseSelfEditValue("objective","😀".repeat(100)),"😀".repeat(100));
});

test("SHU372_PAGE written profile fields overlay imports and a clear stays Not recorded",async()=>{
  const personId="person-populated";
  const preferences={readOwnPreferences:async()=>({displayName:{value:"Written Person",updatedAt:"2026-10-20T10:00:00.000Z"},arabicName:{value:"شخص مكتوب",updatedAt:"2026-10-21T10:00:00.000Z"},objective:{value:null,updatedAt:"2026-10-22T10:00:00.000Z"},intro:{value:"Written introduction",updatedAt:"2026-10-23T10:00:00.000Z"},preferredTime:{value:"Written mornings",updatedAt:"2026-10-24T10:00:00.000Z"}})};
  const repository=new OwnProfileRepository({principals:new InMemoryAuthzStore({principals:[createPrincipal({id:personId,pbuuids:["pbuuid"]})]}),source:new InMemoryApprovedProfileAdapter({links:[{principalId:personId,candidateRef:"candidate"}],rows:new Map([["candidate",SYNTHETIC_PROFILE_FIXTURES.populated]])}),preferences:preferences as any,today:()=>"2026-10-28"});
  const result=await repository.readOwn({requesterPrincipalId:personId,targetPersonId:personId});assert.equal(result.kind,"found");if(result.kind!=="found")return;
  assert.equal(result.profile.fields.displayName.state==="available"&&result.profile.fields.displayName.value,"Written Person");
  assert.equal(result.profile.fields.objective.state,"unavailable");assert.equal(result.profile.fields.objective.freshness.kind,"written_by_person");
  assert.equal(result.profile.fields.preferredTime.freshness.observedAt,"2026-10-24T10:00:00.000Z");
});
