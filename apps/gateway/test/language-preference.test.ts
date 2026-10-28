import assert from "node:assert/strict";
import test from "node:test";

import { failedScenarios, runSafeWriteConformance, SAFE_WRITE_SCENARIOS } from "@studenthub/safe-write-contract";
import { buildSafeWrite, LANGUAGE_POLICY } from "../src/language-preference.js";
import { createLanguagePreference } from "../src/language-preference.js";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { InMemoryAuthzStore, createPrincipal } from "@studenthub/contracts";
import { InMemoryApprovedProfileAdapter, OwnProfileRepository, SYNTHETIC_PROFILE_FIXTURES } from "@studenthub/profile";
import { personRecordRef, safeWritePrincipalRef } from "@studenthub/db";
import type { CommitInput, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";

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

test("SHU371_PAGE_FLOW real profile routes preview the shown value, confirm, and render the write", async (t) => {
  const personId = "person-populated", session = "p".repeat(43), originHolder = { value: "" };
  let value: string | null = null, receipt: Receipt | null = null;
  let updatedAt = "2026-09-14T08:30:00.000Z";
  const port: SafeWriteStore = {
    ownedRecord: (ref) => ref === safeWritePrincipalRef(personId) ? personRecordRef(personId) : null,
    readField: () => value,
    commit: (input: CommitInput) => {
      if (input.expectedBefore !== value) return { ok: false, reason: "state_changed" };
      value = input.value; updatedAt = "2026-09-15T09:45:00.000Z"; receipt = input.receipt; return { ok: true };
    },
  };
  const store = { forPrincipal: () => port, readReceipt: async () => receipt,
    readOwnPreferences: async () => value === null ? null : { language: value, updatedAt } };
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: session, personId });
  const profiles = new OwnProfileRepository({
    principals: new InMemoryAuthzStore({ principals: [createPrincipal({ id: personId, pbuuids: ["pbuuid"] })] }),
    source: new InMemoryApprovedProfileAdapter({ links: [{ principalId: personId, candidateRef: "candidate" }], rows: new Map([["candidate", SYNTHETIC_PROFILE_FIXTURES.populated]]) }),
    preferences: store, today: () => "2026-09-13",
  });
  const preferences = createLanguagePreference({ sessions: rig.sessions, store, secret: "shu371-test-secret-is-at-least-thirty-two-bytes" });
  const app = { ...rig.app, preferences, web: { get origin() { return originHolder.value; }, profiles } };
  const server = createGatewayServer(undefined, undefined, undefined, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  originHolder.value = `http://127.0.0.1:${address.port}`;
  const headers = { cookie: `__Host-studenthub_session=${session}`, accept: "text/html", origin: originHolder.value,
    "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
  const overSnapshot = await (await fetch(`${originHolder.value}/profile`, { headers: { cookie: headers.cookie, accept: "text/html" } })).text();
  assert.match(overSnapshot, /<dt>Language<\/dt><dd>AR<\/dd><small class="field-meta">StudentHub snapshot/);
  const preview = await fetch(`${originHolder.value}/profile/language/preview`, { method: "POST", headers, body: "language=en" });
  const review = await preview.text();
  assert.equal(preview.status, 200); assert.equal(preview.headers.get("cache-control"), "no-store");
  assert.match(review, /Language: <strong>العربية<\/strong> → <strong>English<\/strong>/,
    "SHU371_PAGE_FLOW preview before comes from My profile, not the empty write store");
  assert.doesNotMatch(review, /token[^<]*(?:href|location)=/i);
  const confirm = new URLSearchParams();
  for (const match of review.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) confirm.set(match[1]!, match[2]!.replaceAll("&amp;", "&"));
  const done = await fetch(`${originHolder.value}/profile/language/confirm`, { method: "POST", headers, body: confirm, redirect: "manual" });
  assert.equal(done.status, 303); assert.equal(done.headers.get("location"), "/profile"); assert.equal(value, "en");
  const replay = await fetch(`${originHolder.value}/profile/language/confirm`, { method: "POST", headers, body: confirm });
  assert.equal(replay.status, 409); assert.match(await replay.text(), /profile changed while you were reviewing/);
  const unsigned = await fetch(`${originHolder.value}/profile/language/preview`, {
    method: "POST", headers: { ...headers, cookie: "" }, body: "language=ar",
  });
  assert.equal(unsigned.status, 401); assert.match(await unsigned.text(), /Sign in/);
  const rejected = await fetch(`${originHolder.value}/profile/language/preview`, {
    method: "POST", headers: { ...headers, origin: "https://attacker.invalid", "sec-fetch-site": "cross-site" }, body: "language=ar",
  });
  assert.equal(rejected.status, 403); assert.match(await rejected.text(), /language wasn’t changed/);
  const shown = await (await fetch(`${originHolder.value}/profile`, { headers: { cookie: headers.cookie, accept: "text/html" } })).text();
  assert.match(shown, /<dt>Language<\/dt><dd>EN<\/dd><small class="field-meta">Updated by you · 2026-09-15/,
    "SHU371_SHOWN_OVER_SNAPSHOT renders written English and its write date over Arabic snapshot");
  assert.match(shown, /Checked once your documents are on file/);
});

test("SHU371_PAGE_FLOW unavailable page write renders an HTML 503", async (t) => {
  const rig = createSyntheticLoginRig(createLoginApplication);
  const app = { ...rig.app, web: { origin: "http://127.0.0.1", profiles: new OwnProfileRepository({
    principals: new InMemoryAuthzStore(), source: new InMemoryApprovedProfileAdapter(),
  }) } };
  const server = createGatewayServer(undefined, undefined, undefined, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/profile/language/preview`, {
    method: "POST", headers: { accept: "text/html", origin: "http://127.0.0.1",
      "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" }, body: "language=en",
  });
  assert.equal(response.status, 503); assert.match(await response.text(), /profile service is unavailable/);
});
