import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { failedScenarios, runSafeWriteConformance, SAFE_WRITE_SCENARIOS } from "@studenthub/safe-write-contract";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
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
  assert.match(page,/Language: <strong>English<\/strong> → <strong>العربية<\/strong>/);
  assert.match(page,/type="hidden" name="token\.tokenId"/); assert.doesNotMatch(page,/token=/);
  const params=new URLSearchParams({language:"ar",...Object.fromEntries(Object.keys(token).map(key=>[`token.${key}`,key]))});
  await handleLanguagePreferencePage(request("/profile/language/confirm-page",String(params)),response,service,"https://studenthub.test.invalid",()=>{});
  assert.match(calls.join(" "),/^preview:.* confirm:/);
});

test("SHU371_PAGE_FLOW real gateway routes preserve browser refusals, redirect and JSON parity", async (t) => {
  const session = "s".repeat(43); const origin = "https://studenthub.test.invalid"; let confirms = 0;
  const token = Object.fromEntries(["changeSetDigest", "expectedBeforeDigest", "expiresAt", "issuedAt", "mac", "principalRef", "tokenId"].map(key => [key, key])) as any;
  const service: LanguagePreference = {
    async preview(id, body) { if (!id) return { status: 401, body: { error: "unauthorized" } }; return { status: 200, body: { changes: [{ before: "en", after: (body as any).language }], token } }; },
    async confirm(id, body) { if (!id) return { status: 401, body: { error: "unauthorized" } }; if ((body as any).token.tokenId === "stale") return { status: 409, body: { error: "state_changed" } }; confirms++; return { status: 200, body: {} }; },
    async receipt() { return { status: 404, body: { error: "receipt_not_found" } }; },
  };
  const rig = createSyntheticLoginRig(createLoginApplication); await rig.sessions.put({ id: session, personId: "person-1" });
  const login: any = { ...rig.app, preferences: service, web: { origin, returnTo: rig.config.allowedReturnUrls[1], profiles: { async readOwn(){ return { kind: "not_found" }; } } } };
  const server = createGatewayServer(undefined, undefined, undefined, login); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); }); const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  const formHeaders = { origin, "content-type": "application/x-www-form-urlencoded", cookie: `__Host-studenthub_session=${session}` };
  const unauthorized = await fetch(base + "/profile/language/preview-page", { method: "POST", headers: { origin, "content-type": formHeaders["content-type"] }, body: "language=ar" });
  assert.equal(unauthorized.status, 401); assert.match(await unauthorized.text(), /signed in/i);
  const forbidden = await fetch(base + "/profile/language/preview-page", { method: "POST", headers: { ...formHeaders, origin: "https://attacker.invalid" }, body: "language=ar" }); assert.equal(forbidden.status, 403);
  const preview = await fetch(base + "/profile/language/preview-page", { method: "POST", headers: formHeaders, body: "language=ar" }); const html = await preview.text(); assert.equal(preview.status, 200); assert.match(html, /Language:.*English.*العربية/s); assert.equal(confirms, 0, "preview and Cancel store nothing");
  const params = new URLSearchParams({ language: "ar", ...Object.fromEntries(Object.keys(token).map(key => [`token.${key}`, String(token[key])])) });
  const confirmed = await fetch(base + "/profile/language/confirm-page", { method: "POST", headers: formHeaders, body: params, redirect: "manual" }); assert.equal(confirmed.status, 303); assert.equal(confirmed.headers.get("location"), "/profile"); assert.equal(confirms, 1);
  params.set("token.tokenId", "stale"); const stale = await fetch(base + "/profile/language/confirm-page", { method: "POST", headers: formHeaders, body: params }); assert.equal(stale.status, 409);
  const json = await fetch(base + "/profile/language/preview", { method: "POST", headers: { origin, "content-type": "application/json", cookie: formHeaders.cookie }, body: JSON.stringify({ language: "ar" }) }); assert.equal(json.status, 200); assert.equal((await json.json() as any).changes[0].after, "ar");
  const unavailable = createGatewayServer(undefined, undefined, undefined, { ...login, preferences: undefined }); await new Promise<void>(resolve => unavailable.listen(0, "127.0.0.1", resolve)); t.after(() => { unavailable.closeAllConnections(); unavailable.close(); }); const ua = unavailable.address(); assert.ok(ua && typeof ua !== "string"); const response = await fetch(`http://127.0.0.1:${ua.port}/profile/language/preview-page`, { method: "POST", headers: formHeaders, body: "language=ar" }); assert.equal(response.status, 503);
});
