import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { failedScenarios, runSafeWriteConformance, SAFE_WRITE_SCENARIOS } from "@studenthub/safe-write-contract";
import { buildSafeWrite, handleLanguagePreferencePage, LANGUAGE_POLICY, type LanguagePreference } from "../src/language-preference.js";

test("SHU-84/AC-01 CONFORMANCE the builder the gateway serves passes SHU-82's suite unmodified", async () => {
  const report = await runSafeWriteConformance((input) => buildSafeWrite(input));
  assert.deepEqual(failedScenarios(report), []);
  assert.equal(report.results.length, SAFE_WRITE_SCENARIOS.length);
  assert.equal(report.ok, true);
});

test("SHU-84/AC-01 CONFORMANCE the served policy permits exactly one field", () => {
  assert.deepEqual(LANGUAGE_POLICY, { allowed: ["language"], maxValueLength: 2 });
  assert.ok(Object.isFrozen(LANGUAGE_POLICY) && Object.isFrozen(LANGUAGE_POLICY.allowed));
});

test("SHU371_PAGE_FLOW browser form delegates preview and confirm and keeps token in hidden fields", async () => {
  const calls: string[] = [];
  const token = Object.fromEntries(["changeSetDigest", "expectedBeforeDigest", "expiresAt", "issuedAt", "mac", "principalRef", "tokenId"].map(key => [key, key]));
  const service = { async preview(_session: string|undefined, body: unknown) { calls.push(`preview:${JSON.stringify(body)}`); return { status: 200 as const, body: { changes: [{ before: "en", after: "ar" }], token } }; }, async confirm(_session:string|undefined, body:unknown){calls.push(`confirm:${JSON.stringify(body)}`);return {status:200 as const,body:{}};}, async receipt(){return {status:404 as const,body:{error:"receipt_not_found"}};} } satisfies LanguagePreference;
  const request = (url:string, body:string) => Object.assign(Readable.from([body]), { url, method:"POST", headers:{ origin:"https://studenthub.test.invalid", "content-type":"application/x-www-form-urlencoded", "content-length":String(Buffer.byteLength(body)), cookie:`__Host-studenthub_session=${"s".repeat(43)}` } }) as unknown as IncomingMessage;
  let page=""; const responseState={headersSent:false}; const response = { get headersSent(){return responseState.headersSent;}, writeHead(){responseState.headersSent=true;return response;}, end(){} } as unknown as ServerResponse;
  assert.equal(await handleLanguagePreferencePage(request("/profile/language/preview-page","language=ar"),response,service,"https://studenthub.test.invalid",(_s,_t,body)=>{page=body;}),true);
  assert.match(page,/type="hidden" name="token\.tokenId"/); assert.doesNotMatch(page,/token=/);
  const params=new URLSearchParams({language:"ar",...Object.fromEntries(Object.keys(token).map(key=>[`token.${key}`,key]))});
  await handleLanguagePreferencePage(request("/profile/language/confirm-page",String(params)),response,service,"https://studenthub.test.invalid",()=>{});
  assert.match(calls.join(" "),/^preview:.* confirm:/);
});
