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
  let value: string | null = "en", receipt: Receipt | null = null;
  const port: SafeWriteStore = {
    ownedRecord: (ref) => ref === safeWritePrincipalRef(personId) ? personRecordRef(personId) : null,
    readField: () => value,
    commit: (input: CommitInput) => {
      if (input.expectedBefore !== value) return { ok: false, reason: "state_changed" };
      value = input.value; receipt = input.receipt; return { ok: true };
    },
  };
  const store = { forPrincipal: () => port, readReceipt: async () => receipt,
    readOwnPreferences: async () => value === null ? null : { language: value } };
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
  assert.match(overSnapshot, /<dt>Language<\/dt><dd>EN<\/dd><small class="field-meta">Written by you/,
    "SHU371_SHOWN_OVER_SNAPSHOT renders written English over the Arabic fixture snapshot");
  const preview = await fetch(`${originHolder.value}/profile/language/preview`, { method: "POST", headers, body: "language=ar" });
  const review = await preview.text();
  assert.equal(preview.status, 200); assert.equal(preview.headers.get("cache-control"), "no-store");
  assert.match(review, /SHU371_PAGE_FLOW|Language: <strong>English<\/strong> → <strong>العربية/);
  assert.doesNotMatch(review, /token[^<]*(?:href|location)=/i);
  const confirm = new URLSearchParams();
  for (const match of review.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) confirm.set(match[1]!, match[2]!.replaceAll("&amp;", "&"));
  const done = await fetch(`${originHolder.value}/profile/language/confirm`, { method: "POST", headers, body: confirm, redirect: "manual" });
  assert.equal(done.status, 303); assert.equal(done.headers.get("location"), "/profile"); assert.equal(value, "ar");
  const shown = await (await fetch(`${originHolder.value}/profile`, { headers: { cookie: headers.cookie, accept: "text/html" } })).text();
  assert.match(shown, /<dt>Language<\/dt><dd>AR<\/dd><small class="field-meta">Written by you/);
  assert.match(shown, /Checked once your documents are on file/);
});
