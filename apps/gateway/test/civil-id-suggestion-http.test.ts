import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderCivilIdSuggestion } from "../src/civil-id-suggestion-http.js";

test("OCRP_LINE suggestion rendering masks the number and distinguishes completed outcomes", () => {
  const id="suggestion-1", full="123456781234";
  const shown=renderCivilIdSuggestion("en",{id,state:"read",last4:full.slice(-4),country:"KW",expiry:"2099-03-01",expired:false});
  assert.match(shown,/We read a number ending 1234, expiring 2099-03-01\. Is this right\?/);
  assert.equal((shown.match(/<form /g)??[]).length,2);
  assert.match(shown,/action="\/profile\/civil-id\/suggestion\/accept"/);
  assert.match(shown,/action="\/profile\/civil-id\/suggestion\/dismiss"/);
  assert.doesNotMatch(shown,new RegExp(full),"OCRP_LINE full civil ID must never render");
  const expired=renderCivilIdSuggestion("en",{id,state:"read",last4:"1234",country:"KW",expiry:"2020-01-05",expired:true});
  assert.doesNotMatch(expired,/suggestion\/accept/,"OCRP_LINE expired suggestion must have no accept form");
  assert.match(expired,/The date we read \(2020-01-05\) has passed/);
  const unreadable=renderCivilIdSuggestion("en",{id,state:"unreadable",last4:null,country:null,expiry:null,expired:false});
  const failed=renderCivilIdSuggestion("en",{id,state:"failed",last4:null,country:null,expiry:null,expired:false});
  assert.match(unreadable,/We could not read your photo/);assert.match(failed,/We could not read your photo/);
  assert.equal(renderCivilIdSuggestion("en",undefined),"");
});

test("OCRP_PLACE suggestion is a definition-shaped row", () => {
  const html=renderCivilIdSuggestion("en",{id:"s",state:"read",last4:"1234",country:"KW",expiry:"2099-01-01",expired:false});
  assert.match(html,/^<div class="p-row"><dt>[^<]+<\/dt><dd>/,"OCRP_PLACE suggestion must use the profile dl row shape");
});

test("OCRP_SECRECY gateway opens a suggestion only in the accept module", async () => {
  const source=await readFile(new URL("../src/civil-id-suggestion-http.js",import.meta.url),"utf8");
  assert.equal((source.match(/\.vault\.open\(/g)??[]).length,1,"OCRP_SECRECY exactly one server-side vault open");
  assert.doesNotMatch(source,/name=["']number["']/,"OCRP_SECRECY no civil number form field");
});
