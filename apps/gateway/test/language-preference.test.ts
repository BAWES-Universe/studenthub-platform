import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";

import { failedScenarios, runSafeWriteConformance, SAFE_WRITE_SCENARIOS } from "@studenthub/safe-write-contract";
import { buildSafeWrite, LANGUAGE_POLICY } from "../src/language-preference.js";
import { createLanguagePreference, handleLanguagePreference, handleLanguagePreferencePage, type LanguagePreference } from "../src/language-preference.js";
import { pageDocument } from "../src/web-ui.js";
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
  assert.match(overSnapshot, /<html lang="ar" dir="rtl">/);
  assert.match(overSnapshot, /id="field-language"[\s\S]*?<dt>اللغة<\/dt><dd><bdi[^>]*>العربية<\/bdi>/);
  assert.match(overSnapshot, /class="p-provenance"[\s\S]*?<dt>اللغة<\/dt><dd>تم الاستيراد/);
  const preview = await fetch(`${originHolder.value}/profile/language/preview`, { method: "POST", headers, body: "language=en", redirect: "manual" });
  assert.equal(preview.status, 303); assert.equal(preview.headers.get("location"), "/profile/language/review?language=en");
  assert.equal(preview.headers.get("cache-control"), "no-store"); assert.equal(await preview.text(), "");
  const reviewResponse = await fetch(`${originHolder.value}${preview.headers.get("location")}`, { headers: { cookie: headers.cookie, accept: "text/html" } });
  const review = await reviewResponse.text();
  assert.equal(reviewResponse.status, 200); assert.equal(reviewResponse.headers.get("cache-control"), "no-store");
  assert.match(review, /اللغة: <strong>العربية<\/strong> ← <strong>الإنجليزية<\/strong>/,
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
  assert.match(shown, /id="field-language"[\s\S]*?<dt>Language<\/dt><dd><bdi[^>]*>English<\/bdi>/,
    "SHU371_SHOWN_OVER_SNAPSHOT renders written English over Arabic snapshot");
  assert.match(shown, /class="p-provenance"[\s\S]*?<dt>Language<\/dt><dd>Updated by you on 15 Sept 2026<\/dd>/, "SHU371_SHOWN_OVER_SNAPSHOT retains actual write date in provenance");
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

test("SHU395_RECEIPTS language receipts return 404 for a profile-edit reference and do not own its path", async () => {
  const session = "r".repeat(43), sessions = { get: async (id: string) => id === session ? { id, personId: "person" } : undefined };
  const inert: SafeWriteStore = { ownedRecord: () => null, readField: () => null, commit: () => ({ ok: false, reason: "not_own_record" }) };
  const service = createLanguagePreference({ sessions, store: { forPrincipal: () => inert, readReceipt: async () => null }, secret: "receipt-isolation-secret-at-least-thirty-two-bytes" });
  assert.deepEqual(await service.receipt(session, "a".repeat(64)), { status: 404, body: { error: "receipt_not_found" } });
  const request = Readable.from([]) as IncomingMessage; request.url = `/profile/edit/receipts/${"a".repeat(64)}`; request.method = "GET"; request.headers = {};
  assert.equal(await handleLanguagePreference(request, {} as ServerResponse, service, "https://studenthub.example.invalid"), false);
});

const LOCALIZED_TOKEN_KEYS = ["changeSetDigest", "expectedBeforeDigest", "expiresAt", "issuedAt", "mac", "principalRef", "tokenId"] as const;
const LOCALIZED_ACCOUNTS = {
  en: { personId: "synthetic-language-en", session: "e".repeat(43), language: "en" },
  ar: { personId: "synthetic-language-ar", session: "a".repeat(43), language: "ar" },
  unknown: { personId: "synthetic-language-unknown", session: "u".repeat(43), language: "unsupported-locale" },
} as const;
type LocalizedAccount = keyof typeof LOCALIZED_ACCOUNTS;

// Keep the production authorization, projection and safe-write service in the
// HTTP tests. Only dependency failures and hostile rendering inputs use stubs.
async function localizedGateway(t: TestContext) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  for (const account of Object.values(LOCALIZED_ACCOUNTS)) {
    await rig.sessions.put({ id: account.session, personId: account.personId });
  }
  const values = new Map<string, string | null>(), receipts = new Map<string, Receipt>(), spentTokens = new Set<string>();
  const controls = { now: Date.parse("2026-11-05T08:00:00Z"), failRead: false, denyWrite: false, failCommit: false, reads: [] as string[], authorizations: [] as (string | undefined)[], commits: 0 };
  const store = {
    forPrincipal(personId: string): SafeWriteStore {
      return {
        ownedRecord: (ref) => !controls.denyWrite && ref === safeWritePrincipalRef(personId) ? personRecordRef(personId) : null,
        readField: () => values.get(personId) ?? null,
        commit: (input) => {
          if (spentTokens.has(input.tokenId)) return { ok: false, reason: "token_already_used" };
          controls.commits++;
          if (controls.failCommit) throw Error("SYNTHETIC-PRIVATE-COMMIT-FAILURE");
          if (input.expectedBefore !== (values.get(personId) ?? null)) return { ok: false, reason: "state_changed" };
          values.set(personId, input.value); receipts.set(personId, input.receipt); spentTokens.add(input.tokenId);
          return { ok: true };
        },
      };
    },
    readReceipt: async (personId: string) => receipts.get(personId) ?? null,
    readOwnPreferences: async (personId: string) => values.has(personId)
      ? { language: values.get(personId), updatedAt: "2026-11-05T07:00:00.000Z" } : null,
  };
  const profiles = new OwnProfileRepository({
    principals: new InMemoryAuthzStore({ principals: Object.values(LOCALIZED_ACCOUNTS).map(({ personId }) => createPrincipal({ id: personId, pbuuids: [] })) }),
    source: new InMemoryApprovedProfileAdapter({
      links: Object.values(LOCALIZED_ACCOUNTS).map(({ personId }) => ({ principalId: personId, candidateRef: personId })),
      rows: new Map(Object.values(LOCALIZED_ACCOUNTS).map(({ personId, language }) => [personId, {
        ...SYNTHETIC_PROFILE_FIXTURES.populated, candidate_language_pref: language,
        candidate_name: "SYNTHETIC-PRIVATE-PROFILE-CANARY",
      }])),
    }),
    preferences: store, today: () => "2026-11-05",
  });
  const service = createLanguagePreference({ sessions: rig.sessions, store, secret: "synthetic-localized-language-secret-at-least-32-bytes", clock: { now: () => new Date(controls.now) } });
  const origin = { value: "" };
  const app = {
    ...rig.app, preferences: service as LanguagePreference | undefined,
    async profile(request: Parameters<typeof rig.app.profile>[0]) {
      controls.authorizations.push(request.sessionId);
      return rig.app.profile(request);
    },
    web: { get origin() { return origin.value; }, profiles: {
      async readOwn(request: Parameters<typeof profiles.readOwn>[0]) {
        controls.reads.push(request.requesterPrincipalId);
        assert.equal(request.requesterPrincipalId, request.targetPersonId);
        if (controls.failRead) throw Error("SYNTHETIC-PRIVATE-LOOKUP-FAILURE");
        return profiles.readOwn(request);
      },
    } },
  };
  const server = createGatewayServer(undefined, undefined, undefined, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  origin.value = `http://127.0.0.1:${address.port}`;
  const headers = (account?: LocalizedAccount) => ({
    accept: "text/html", origin: origin.value, "sec-fetch-site": "same-origin",
    "content-type": "application/x-www-form-urlencoded",
    ...(account ? { cookie: `__Host-studenthub_session=${LOCALIZED_ACCOUNTS[account].session}` } : {}),
  });
  const post = (account: LocalizedAccount | undefined, body: string | URLSearchParams, options: {
    path?: string; headers?: Record<string, string>; method?: string;
  } = {}) => fetch(`${origin.value}${options.path ?? "/profile/language/preview"}`, {
    method: options.method ?? "POST", headers: { ...headers(account), ...options.headers },
    ...(options.method === "GET" ? {} : { body }), redirect: "manual",
  });
  const getReview = (account: LocalizedAccount | undefined, query = "language=en", extraHeaders: Record<string, string> = {}) => fetch(`${origin.value}/profile/language/review?${query}`, {
    headers: { accept: "text/html", ...(account ? { cookie: headers(account).cookie! } : {}), ...extraHeaders }, redirect: "manual",
  });
  const review = async (account: LocalizedAccount, body: string, options: Parameters<typeof post>[2] = {}) => {
    const response = await post(account, body, options);
    assert.equal(response.status, 303, "LANGUAGE_HISTORY_POST_REDIRECT Preview must leave POST history before Review");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const target = new URLSearchParams(body).get("language");
    assert.equal(response.headers.get("location"), `/profile/language/review?language=${target}`);
    assert.equal(await response.text(), "", "redirect carries no inline Review or token");
    return getReview(account, `language=${target}`, options.headers);
  };
  return { app, rig, service, controls, values, origin, headers, post, review, getReview };
}

function decodeFormValue(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function localizedConfirmForm(document: string): URLSearchParams {
  const form = new URLSearchParams();
  for (const match of document.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    form.set(match[1]!, decodeFormValue(match[2]!));
  }
  assert.deepEqual([...form.keys()].sort(), ["language", ...LOCALIZED_TOKEN_KEYS.map((key) => `token.${key}`)].sort());
  return form;
}

function visibleLanguageCopy(document: string): string {
  // Hidden form/token values, URL attributes and the product name in <title>
  // are not visible interface copy and must not trigger language assertions.
  const body = /<body>([\s\S]*?)<\/body>/.exec(document)?.[1] ?? document;
  return decodeFormValue(body.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function assertArabicPage(document: string): void {
  assert.match(document, /<html lang="ar" dir="rtl">/);
  assert.doesNotMatch(visibleLanguageCopy(document), /[A-Za-z]/, "Arabic interface has no English visible copy");
  assert.doesNotMatch(document, /SYNTHETIC-PRIVATE/);
}

test("LANGUAGE_LOCALE_REVIEW gateway uses current authorized language, not target, query or headers", async (t) => {
  const x = await localizedGateway(t);
  for (const [account, target] of [["en", "ar"], ["ar", "en"]] as const) {
    const response = await x.review(account, `language=${target}`, {
      path: `/profile/language/preview?language=${target}&lang=${target}&locale=${target}`,
      headers: { "accept-language": target, "x-language": target, "x-locale": target },
    });
    const document = await response.text();
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type")!, /text\/html/);
    assert.equal(localizedConfirmForm(document).get("language"), target);
    assert.match(document, /<form method="post" action="\/profile\/language\/confirm">/);
    if (account === "ar") {
      assertArabicPage(document);
      assert.match(document, /<title>مراجعة اللغة · StudentHub<\/title>/);
      assert.match(document, /<h1>مراجعة تغيير اللغة/);
      assert.match(document, /اللغة: <strong>العربية<\/strong> ← <strong>الإنجليزية<\/strong>/);
      assert.match(document, /<button[^>]*>تأكيد التغيير<\/button>/);
      assert.match(document, /<a class="text-link" href="\/profile">إلغاء<\/a>/);
    } else {
      assert.match(document, /<html lang="en" dir="ltr">/);
      assert.match(document, /<title>Review language · StudentHub<\/title>/);
      assert.match(document, /<h1>Review language change/);
      assert.match(document, /Language: <strong>English<\/strong> → <strong>Arabic<\/strong>/);
      assert.match(document, /<button[^>]*>Confirm change<\/button>/);
      assert.match(document, /<a class="text-link" href="\/profile">Cancel<\/a>/);
    }
  }
  assert.deepEqual(x.controls.reads, [LOCALIZED_ACCOUNTS.en.personId, LOCALIZED_ACCOUNTS.en.personId, LOCALIZED_ACCOUNTS.ar.personId, LOCALIZED_ACCOUNTS.ar.personId], "POST and fresh GET each authorize their own profile read");
  assert.equal(x.controls.commits, 0);
});

test("LANGUAGE_LOCALE_ERRORS malformed forms, invalid values and ownership refusals retain trusted Arabic", async (t) => {
  const x = await localizedGateway(t);
  for (const [path, body] of [
    ["/profile/language/preview", "language=en&language=ar"],
    ["/profile/language/preview", "language=en&locale=en"],
    ["/profile/language/preview", "language=xx"],
    ["/profile/language/confirm", "language=en"],
  ]) {
    const response = await x.post("ar", body!, { path });
    const document = await response.text();
    assert.equal(response.status, 400); assertArabicPage(document);
    assert.match(document, /لم يتم تغيير لغتك\./); assert.match(document, /لم يعد هذا التغيير متاحًا\./);
    assert.match(document, /href="\/profile">العودة إلى ملفي الشخصي<\/a>/);
    assert.doesNotMatch(document, /<form|name="token\./);
  }
  x.controls.denyWrite = true;
  const refused = await x.getReview("ar");
  const document = await refused.text();
  assert.equal(refused.status, 403); assertArabicPage(document); assert.match(document, /لم يعد هذا التغيير متاحًا\./);
  assert.equal(x.controls.commits, 0);
});

test("LANGUAGE_LOCALE_CONFLICT real stale token stays Arabic and a successful confirm keeps its 303", async (t) => {
  const x = await localizedGateway(t);
  const form = localizedConfirmForm(await (await x.review("ar", "language=en")).text());
  x.values.set(LOCALIZED_ACCOUNTS.ar.personId, "ar");
  const stale = await x.post("ar", form, { path: "/profile/language/confirm" });
  const document = await stale.text();
  assert.equal(stale.status, 409); assertArabicPage(document);
  assert.match(document, /تغيّر ملفك الشخصي أثناء المراجعة\. افتحه مجددًا وأعد المحاولة\./);
  assert.equal(x.values.get(LOCALIZED_ACCOUNTS.ar.personId), "ar");
  const current = localizedConfirmForm(await (await x.review("ar", "language=en")).text());
  const done = await x.post("ar", current, { path: "/profile/language/confirm" });
  assert.equal(done.status, 303); assert.equal(done.headers.get("location"), "/profile");
  assert.equal(done.headers.get("cache-control"), "no-store"); assert.equal(await done.text(), "");
  assert.equal(x.values.get(LOCALIZED_ACCOUNTS.ar.personId), "en");
});

test("LANGUAGE_LOCALE_UNAVAILABLE trusted Arabic covers missing service, dependency failure and uncertain confirm", async (t) => {
  const x = await localizedGateway(t);
  x.app.preferences = undefined;
  const missing = await x.post("ar", "language=en");
  const missingDocument = await missing.text();
  assert.equal(missing.status, 503); assertArabicPage(missingDocument);
  assert.match(missingDocument, /خدمة الملف الشخصي غير متاحة\. يرجى المحاولة مجددًا بعد قليل\./);
  x.app.preferences = { ...x.service, preview: async () => { throw Error("SYNTHETIC-PRIVATE-SERVICE-FAILURE"); } };
  const failed = await x.getReview("ar");
  assert.equal(failed.status, 503); assertArabicPage(await failed.text());
  x.app.preferences = x.service;
  const form = localizedConfirmForm(await (await x.review("ar", "language=en")).text());
  x.controls.failCommit = true;
  const unconfirmed = await x.post("ar", form, { path: "/profile/language/confirm" });
  const document = await unconfirmed.text();
  assert.equal(unconfirmed.status, 503); assertArabicPage(document);
  assert.match(document, /لم يتم تأكيد تغيير اللغة\./);
  assert.match(document, /تعذّر التأكد مما إذا كانت لغتك قد تغيّرت\. افتح ملفك الشخصي للتحقق قبل المحاولة مجددًا\./);
  assert.doesNotMatch(document, /لم يتم تغيير لغتك/);
});

test("LANGUAGE_LOCALE_SESSION a service 401 after trusted Arabic lookup stays localized", async (t) => {
  const x = await localizedGateway(t);
  // A session can expire between the authorized display read and the write.
  const authorize = x.app.profile;
  x.app.profile = async (request) => {
    const result = await authorize(request);
    if (request.sessionId) await x.rig.sessions.delete(request.sessionId);
    return result;
  };
  const response = await x.post("ar", "language=en");
  const document = await response.text();
  assert.equal(response.status, 401); assertArabicPage(document);
  assert.match(document, /سجّل الدخول مجددًا للمتابعة بأمان\./);
  assert.match(document, /ربما انتهت جلستك\. افتح ملفك الشخصي لتسجيل الدخول مجددًا\./);
  assert.match(document, /href="\/profile">العودة إلى ملفي الشخصي<\/a>/);
  assert.doesNotMatch(document, /<form|name="token\./);
});

test("LANGUAGE_LOCALE_BOUNDARY unsigned, invalid-cookie and cross-origin forms do not disclose or resolve locale", async (t) => {
  const x = await localizedGateway(t);
  for (const cookie of ["", "__Host-studenthub_session=invalid", `__Host-studenthub_session=${"z".repeat(43)}`]) {
    const response = await x.post(undefined, "language=ar", { headers: { cookie, "accept-language": "ar" } });
    const document = await response.text();
    assert.equal(response.status, 401); assert.match(document, /<html lang="en"(?: dir="ltr")?>/);
    assert.match(document, /Sign in/); assert.doesNotMatch(document, /SYNTHETIC-PRIVATE|name="token\.|العربية/);
  }
  for (const headers of [
    { origin: "https://attacker.invalid", "sec-fetch-site": "same-origin" },
    { origin: x.origin.value, "sec-fetch-site": "cross-site" },
  ]) {
    const response = await x.post("ar", "language=en", { headers });
    const document = await response.text();
    assert.equal(response.status, 403); assert.match(document, /<html lang="en" dir="ltr">/);
    assert.match(document, /Your language wasn’t changed/);
    assert.doesNotMatch(document, /SYNTHETIC-PRIVATE|name="token\.|العربية/);
  }
  const missingOriginHeaders = new Headers(x.headers("ar")); missingOriginHeaders.delete("origin");
  const missingOrigin = await fetch(`${x.origin.value}/profile/language/preview`, {
    method: "POST", headers: missingOriginHeaders, body: "language=en",
  });
  assert.equal(missingOrigin.status, 403);
  assert.match(await missingOrigin.text(), /<html lang="en" dir="ltr">/);
  const wrongMethod = await x.post("ar", "", { method: "GET" });
  assert.equal(wrongMethod.status, 404); assert.match(await wrongMethod.text(), /<html lang="en" dir="ltr">/);
  assert.deepEqual(x.controls.reads, []); assert.equal(x.controls.commits, 0);
  assert.deepEqual(x.controls.authorizations, ["z".repeat(43)], "unsafe or malformed requests never invoke the authorized locale callback");
});

test("LANGUAGE_LOCALE_FALLBACK unknown locale uses English while a failed successful-preview lookup remains 503", async (t) => {
  const x = await localizedGateway(t);
  const unknown = await x.review("unknown", "language=ar", { headers: { "accept-language": "ar" } });
  const unknownDocument = await unknown.text();
  assert.equal(unknown.status, 200); assert.match(unknownDocument, /<html lang="en" dir="ltr">/);
  assert.match(unknownDocument, /Language: <strong>Unavailable<\/strong> → <strong>Arabic<\/strong>/);
  assert.doesNotMatch(unknownDocument, /unsupported-locale/);
  const form = localizedConfirmForm(await (await x.review("ar", "language=en")).text());
  x.controls.failRead = true;
  const fallbackPreview = await x.review("ar", "language=en");
  const fallbackDocument = await fallbackPreview.text();
  assert.equal(fallbackPreview.status, 503); assert.match(fallbackDocument, /<html lang="en" dir="ltr">/);
  assert.match(fallbackDocument, /The profile service is unavailable/);
  assert.doesNotMatch(fallbackDocument, /<form|name="token\.|SYNTHETIC-PRIVATE/);
  for (const [path, body] of [
    ["/profile/language/preview", "language=xx"],
    ["/profile/language/preview", "language=en&language=ar"],
    ["/profile/language/confirm", "language=en"],
  ]) {
    const malformed = await x.post("ar", body!, { path });
    const malformedDocument = await malformed.text();
    assert.equal(malformed.status, 400); assert.match(malformedDocument, /<html lang="en" dir="ltr">/);
    assert.match(malformedDocument, /This change is no longer available/); assert.doesNotMatch(malformedDocument, /SYNTHETIC-PRIVATE/);
  }
  for (const status of [401, 403, 409, 503] as const) {
    x.app.preferences = { ...x.service, preview: async () => ({ status, body: { error: "SYNTHETIC-PRIVATE-ERROR" } }) };
    const response = await x.getReview("ar");
    const document = await response.text();
    assert.equal(response.status, status, "locale lookup failure does not replace a service status");
    assert.match(document, /<html lang="en"(?: dir="ltr")?>/);
    assert.doesNotMatch(document, /SYNTHETIC-PRIVATE/);
  }
  x.app.preferences = x.service;
  const done = await x.post("ar", form, { path: "/profile/language/confirm" });
  assert.equal(done.status, 303); assert.equal(done.headers.get("location"), "/profile");
  assert.equal(x.values.get(LOCALIZED_ACCOUNTS.ar.personId), "en");
});

test("LANGUAGE_LOCALE_VALIDATION only exact trusted en/ar values select interface metadata", async (t) => {
  const x = await localizedGateway(t);
  for (const shown of ["fr", "AR", "ar-KW", '<script>locale()</script>', undefined]) {
    const request = Readable.from(["language=ar"]) as IncomingMessage;
    request.url = "/profile/language/review?language=ar"; request.method = "GET";
    request.headers = { ...x.headers("ar"), "accept-language": "ar" };
    let document = "", reads = 0;
    const handled = await handleLanguagePreferencePage(request, { setHeader() {} } as unknown as ServerResponse, x.service, x.origin.value,
      (status, title, body, language) => { assert.equal(status, 200); document = pageDocument(title, body, language); },
      async (sessionId) => { reads++; assert.equal(sessionId, LOCALIZED_ACCOUNTS.ar.session); return shown; });
    assert.equal(handled, true); assert.equal(reads, 1);
    assert.match(document, /<html lang="en" dir="ltr">/);
    assert.match(document, /Language: <strong>Unavailable<\/strong> → <strong>Arabic<\/strong>/);
    assert.doesNotMatch(document, /<script>|ar-KW|lang="fr"|lang="AR"/);
  }
});

test("LANGUAGE_LOCALE_ESCAPE hidden token and form values remain escaped without English visible Arabic copy", async (t) => {
  const x = await localizedGateway(t);
  const hostile = `"><script>syntheticToken()</script>&'`;
  const token = Object.fromEntries(LOCALIZED_TOKEN_KEYS.map((key) => [key, `${key}${hostile}`]));
  // This deliberately permissive service isolates the rendering boundary. Real
  // requests still validate the language enum in the production service above.
  x.app.preferences = { ...x.service, preview: async () => ({ status: 200, body: { changes: [], token } }) };
  const response = await x.getReview("ar");
  const document = await response.text();
  assert.equal(response.status, 200); assertArabicPage(document);
  assert.match(document, /اللغة: <strong>العربية<\/strong> ← <strong>الإنجليزية<\/strong>/);
  assert.doesNotMatch(document, /<script>|<img|value="">/);
  assert.match(document, /&quot;&gt;&lt;script&gt;syntheticToken\(\)&lt;\/script&gt;&amp;&#39;/);
  const form = localizedConfirmForm(document);
  assert.equal(form.get("language"), "en");
  for (const key of LOCALIZED_TOKEN_KEYS) assert.equal(form.get(`token.${key}`), token[key]);
});

test("LANGUAGE_LOCALE_JSON Arabic browser preferences leave the JSON service and receipt protocol unchanged", async (t) => {
  const x = await localizedGateway(t);
  const headers = { "content-type": "application/json", "accept-language": "ar" };
  const preview = await x.post("ar", JSON.stringify({ language: "en" }), { headers });
  assert.equal(preview.status, 200); assert.equal(preview.headers.get("content-type"), "application/json");
  const body = await preview.json() as { changes: unknown; token: Record<string, string> };
  assert.deepEqual(Object.keys(body).sort(), ["changes", "token"]);
  assert.deepEqual(Object.keys(body.token).sort(), [...LOCALIZED_TOKEN_KEYS].sort());
  const confirm = await x.post("ar", JSON.stringify({ language: "en", token: body.token }), { path: "/profile/language/confirm", headers });
  assert.equal(confirm.status, 200); assert.equal(confirm.headers.get("location"), null);
  assert.deepEqual(Object.keys(await confirm.json() as object), ["receipt"]);
  const invalid = await x.post("ar", JSON.stringify({ language: "xx" }), { headers });
  assert.equal(invalid.status, 400); assert.deepEqual(await invalid.json(), { error: "invalid_value" });
  assert.deepEqual(x.controls.reads, [], "JSON requests never resolve display locale");
});

test("LANGUAGE_LOCALE_ISOLATION overlapping Arabic and English requests retain their own trusted copy", { timeout: 5000 }, async (t) => {
  const x = await localizedGateway(t);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  x.app.preferences = { ...x.service, preview: async (sessionId, body) => {
    if (sessionId === LOCALIZED_ACCOUNTS.ar.session) { entered(); await gate; }
    return x.service.preview(sessionId, body);
  } };
  const arabic = x.getReview("ar");
  await waiting;
  const english = await x.getReview("en", "language=ar");
  const englishDocument = await english.text();
  assert.equal(english.status, 200); assert.match(englishDocument, /<html lang="en" dir="ltr">/);
  assert.match(englishDocument, /Language: <strong>English<\/strong> → <strong>Arabic<\/strong>/);
  release();
  const arabicResponse = await arabic, arabicDocument = await arabicResponse.text();
  assert.equal(arabicResponse.status, 200); assertArabicPage(arabicDocument);
  assert.match(arabicDocument, /اللغة: <strong>العربية<\/strong> ← <strong>الإنجليزية<\/strong>/);
  assert.notEqual(localizedConfirmForm(englishDocument).get("token.principalRef"), localizedConfirmForm(arabicDocument).get("token.principalRef"));
  assert.deepEqual(x.controls.reads, [LOCALIZED_ACCOUNTS.ar.personId, LOCALIZED_ACCOUNTS.en.personId]);
});


test("LANGUAGE_LOCALE_UNKNOWN_OUTCOME a committed service throw never claims the language was unchanged", async (t) => {
  const x = await localizedGateway(t);
  x.app.preferences = { ...x.service, confirm: async (sessionId, body) => {
    const result = await x.service.confirm(sessionId, body);
    assert.equal(result.status, 200);
    throw Error("SYNTHETIC-PRIVATE-AFTER-COMMIT-FAILURE");
  } };
  for (const [account, target] of [["ar", "en"], ["en", "ar"]] as const) {
    const form = localizedConfirmForm(await (await x.review(account, `language=${target}`)).text());
    const response = await x.post(account, form, { path: "/profile/language/confirm" });
    const document = await response.text();
    assert.equal(response.status, 503); assert.equal(response.headers.get("location"), null);
    assert.equal(x.values.get(LOCALIZED_ACCOUNTS[account].personId), target, "the commit happened before the response was lost");
    assert.doesNotMatch(document, /SYNTHETIC-PRIVATE|<form|name="token\./);
    if (account === "ar") {
      assertArabicPage(document); assert.match(document, /لم يتم تأكيد تغيير اللغة\./);
      assert.match(document, /تعذّر التأكد مما إذا كانت لغتك قد تغيّرت/);
      assert.doesNotMatch(document, /لم يتم تغيير لغتك/);
    } else {
      assert.match(document, /<html lang="en" dir="ltr">/);
      assert.match(document, /Your language change wasn’t confirmed\./);
      assert.match(document, /We couldn’t confirm whether your language was changed/);
      assert.doesNotMatch(document, /Your language wasn’t changed/);
    }
  }
});


test("LANGUAGE_LOCALE_CONFIRM_AUTHORITY display lookup failure preserves confirm status, redirect and committed receipt", async (t) => {
  const outcomes: unknown[] = [];
  for (const failRead of [false, true]) {
    const x = await localizedGateway(t);
    const form = localizedConfirmForm(await (await x.review("ar", "language=en")).text());
    let committedReceipt: Receipt | undefined;
    x.app.preferences = { ...x.service, confirm: async (sessionId, body) => {
      const result = await x.service.confirm(sessionId, body);
      if (result.status === 200) committedReceipt = (result.body as { receipt: Receipt }).receipt;
      return result;
    } };
    x.controls.failRead = failRead;
    const done = await x.post("ar", form, { path: "/profile/language/confirm" });
    assert.equal(done.status, 303); assert.equal(done.headers.get("location"), "/profile");
    assert.equal(done.headers.get("cache-control"), "no-store"); assert.equal(await done.text(), "");
    assert.ok(committedReceipt, "the production service committed a receipt");
    const receipt = await x.service.receipt(LOCALIZED_ACCOUNTS.ar.session, committedReceipt.receiptRef);
    assert.deepEqual(receipt, { status: 200, body: { receipt: committedReceipt } }, "display failure does not replace or alter the authoritative receipt");
    assert.equal(x.values.get(LOCALIZED_ACCOUNTS.ar.personId), "en");
    const replay = await x.post("ar", form, { path: "/profile/language/confirm" });
    const replayDocument = await replay.text();
    assert.equal(replay.status, 409); assert.equal(replay.headers.get("location"), null);
    assert.match(replayDocument, /<html lang="en" dir="ltr">/);
    assert.match(replayDocument, /Your profile changed while you were reviewing/);
    const refusedStatuses: number[] = [];
    for (const status of [400, 401, 403, 409, 503] as const) {
      x.app.preferences = { ...x.service, confirm: async () => ({ status, body: { error: "SYNTHETIC-PRIVATE-REFUSAL" } }) };
      const refused = await x.post("ar", form, { path: "/profile/language/confirm" });
      const document = await refused.text();
      assert.equal(refused.status, status); assert.equal(refused.headers.get("location"), null);
      assert.match(document, /<html lang="en"(?: dir="ltr")?>/);
      assert.doesNotMatch(document, /SYNTHETIC-PRIVATE|name="token\./);
      refusedStatuses.push(refused.status);
    }
    assert.deepEqual(await x.service.receipt(LOCALIZED_ACCOUNTS.ar.session, committedReceipt.receiptRef), receipt);
    const { receiptRef: _uniqueReceiptRef, committedAt: _commitTime, ...receiptContract } = committedReceipt;
    outcomes.push({ status: done.status, location: done.headers.get("location"), replayStatus: replay.status, refusedStatuses, receiptContract });
  }
  // Independent writes have distinct receipt IDs/timestamps. Their semantic
  // receipt content and HTTP outcomes must not depend on a display-only read.
  assert.deepEqual(outcomes[1], outcomes[0]);
});

test("LANGUAGE_HISTORY_POST_REDIRECT native Preview has no inline token and fresh GET revalidates", async (t) => {
  const x = await localizedGateway(t);
  let previews = 0;
  x.app.preferences = { ...x.service, preview: async (sessionId, body) => { previews++; return x.service.preview(sessionId, body); } };
  const redirect = await x.post("ar", "language=en");
  assert.equal(redirect.status, 303, "LANGUAGE_HISTORY_POST_REDIRECT Preview must redirect instead of rendering inline 200");
  assert.equal(redirect.headers.get("location"), "/profile/language/review?language=en");
  assert.equal(redirect.headers.get("cache-control"), "no-store");
  assert.equal(await redirect.text(), ""); assert.equal(previews, 0, "POST must not issue a discarded signed token");
  const first = await x.getReview("ar"), firstDocument = await first.text();
  assert.equal(first.status, 200); assert.equal(first.headers.get("cache-control"), "no-store");
  const original = localizedConfirmForm(firstDocument);
  const fresh = await x.getReview("ar"), freshDocument = await fresh.text();
  assert.equal(fresh.status, 200); assert.equal(fresh.headers.get("cache-control"), "no-store");
  const displayed = localizedConfirmForm(freshDocument);
  assert.notEqual(displayed.get("token.tokenId"), original.get("token.tokenId"), "GET revalidates rather than restoring the original token");
  assert.equal(previews, 2); assert.equal(x.controls.commits, 0);
  for (const document of [firstDocument, freshDocument]) {
    assertArabicPage(document);
    assert.doesNotMatch(document, /(?:href|action)="[^"]*(?:token|mac|principalRef|changeSetDigest)/i);
    assert.doesNotMatch(document, /localStorage|sessionStorage|indexedDB|serviceWorker|<script/i);
  }
  for (const response of [redirect, first, fresh]) {
    assert.equal(response.headers.get("set-cookie"), null);
    assert.doesNotMatch(JSON.stringify([...response.headers]), /tokenId|principalRef|changeSetDigest|SYNTHETIC-PRIVATE/);
  }
  const done = await x.post("ar", displayed, { path: "/profile/language/confirm" });
  assert.equal(done.status, 303); assert.equal(done.headers.get("location"), "/profile");
  assert.equal(x.values.get(LOCALIZED_ACCOUNTS.ar.personId), "en");
});

test("LANGUAGE_HISTORY_QUERY invalid Review URLs refuse generically without echo or writes", async (t) => {
  const x = await localizedGateway(t);
  for (const query of ["", "language=", "language=xx", "language=EN", "language=en&language=en", "language=en&language=ar", "language=en&locale=ar", "language=en&token.mac=SYNTHETIC-PRIVATE-QUERY", "language=%3Cscript%3ESYNTHETIC-PRIVATE%3C%2Fscript%3E", "language=%", "language=%00en"]) {
    const response = await x.getReview("ar", query);
    const document = await response.text();
    assert.equal(response.status, 400, query); assert.equal(response.headers.get("cache-control"), "no-store");
    assertArabicPage(document); assert.match(document, /لم يتم تغيير لغتك\./);
    assert.doesNotMatch(document, /<form|name="token\.|<script>|SYNTHETIC-PRIVATE|language=|token\.mac/);
    assert.equal(response.headers.get("location"), null);
  }
  assert.equal(x.controls.commits, 0);
});

test("LANGUAGE_HISTORY_SESSION restored Review reauthenticates and never reuses another session", async (t) => {
  const x = await localizedGateway(t);
  const old = localizedConfirmForm(await (await x.review("ar", "language=en")).text());
  await x.rig.sessions.delete(LOCALIZED_ACCOUNTS.ar.session);
  for (const account of [undefined, "ar"] as const) {
    const response = await x.getReview(account), document = await response.text();
    assert.equal(response.status, 401); assert.match(document, /Sign in/);
    assert.doesNotMatch(document, /name="token\.|SYNTHETIC-PRIVATE|العربية/);
  }
  const crossSession = await x.post("en", old, { path: "/profile/language/confirm" });
  assert.equal(crossSession.status, 409);
  assert.equal(x.controls.commits, 0);
});

test("LANGUAGE_HISTORY_NO_CHANGE current target has existing not-changed copy without Confirm", async (t) => {
  const x = await localizedGateway(t);
  for (const account of ["ar", "en"] as const) {
    const response = await x.getReview(account, `language=${account}`), document = await response.text();
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(document, account === "ar" ? /لم يتم تغيير لغتك\./ : /Your language wasn’t changed/);
    assert.doesNotMatch(document, /<form|name="token\.|Confirm change|تأكيد التغيير/);
  }
  assert.equal(x.controls.commits, 0);
});

test("LANGUAGE_HISTORY_OLD_TOKEN fresh GET does not revoke earlier valid tokens or relax stale expiry and single-use rules", async (t) => {
  for (const scenario of ["valid", "stale", "expired", "used"] as const) {
    const x = await localizedGateway(t);
    const old = localizedConfirmForm(await (await x.review("ar", "language=en")).text());
    if (scenario === "stale") x.values.set(LOCALIZED_ACCOUNTS.ar.personId, "ar");
    if (scenario === "expired") x.controls.now += 24 * 60 * 60 * 1000;
    if (scenario === "used") {
      assert.equal((await x.post("ar", old, { path: "/profile/language/confirm" })).status, 303);
      // Restore the original value so the store's durable single-use guard,
      // rather than merely state_changed, is what rejects this replay.
      x.values.set(LOCALIZED_ACCOUNTS.ar.personId, null);
    }
    const fresh = await x.getReview("ar");
    assert.equal(fresh.status, 200); await fresh.text();
    const before = x.controls.commits;
    const result = await x.post("ar", old, { path: "/profile/language/confirm" });
    assert.equal(result.status, scenario === "valid" ? 303 : 409, scenario);
    assert.equal(x.controls.commits, before + (scenario === "valid" ? 1 : 0), scenario);
  }
});

test("LANGUAGE_HISTORY_GET_BOUNDARY review works without form Content-Type or Origin and preserves dependency refusals", async (t) => {
  const x = await localizedGateway(t);
  const response = await x.getReview("ar", "language=en", { "accept-language": "en", "x-locale": "en", "content-type": "application/json" });
  assert.equal(response.status, 200); assertArabicPage(await response.text());
  x.controls.denyWrite = true;
  assert.equal((await x.getReview("ar")).status, 403);
  x.controls.denyWrite = false; x.controls.failRead = true;
  const failed = await x.getReview("ar"); assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /SYNTHETIC-PRIVATE|name="token\./);
  x.controls.failRead = false; x.app.preferences = undefined;
  const missing = await x.getReview("ar"); assert.equal(missing.status, 503); assertArabicPage(await missing.text());
  assert.equal(x.controls.commits, 0);
});

test("LANGUAGE_HISTORY_INLINE_200_MUTANT dies at the native Preview redirect assertion", () => {
  const sourcePath = new URL("../src/language-preference.js", import.meta.url);
  const original = readFileSync(sourcePath, "utf8");
  const from = 'response.writeHead(303, { location: `${FORM_REVIEW}?language=${target}`, "cache-control": "no-store" });';
  const to = 'write(200, "Review language", "<main>Review language change</main>", locale);';
  assert.equal(original.split(from).length, 2, "exactly one native Preview redirect mutation site");
  const dir = mkdtempSync(join(dirname(fileURLToPath(sourcePath)), "language-history-mutant-"));
  try {
    const modulePath = join(dir, "language-preference.mjs");
    const script = `import assert from 'node:assert/strict';
      import { Readable } from 'node:stream';
      import { handleLanguagePreferencePage } from ${JSON.stringify(pathToFileURL(modulePath).href)};
      const request = Readable.from(['language=en']);
      request.url='/profile/language/preview'; request.method='POST';
      request.headers={'content-type':'application/x-www-form-urlencoded',origin:'https://studenthub.invalid','sec-fetch-site':'same-origin',cookie:'__Host-studenthub_session='+'a'.repeat(43)};
      let status=0;
      const response={writeHead(code){status=code;},end(){},setHeader(){}};
      const service={validatePreview:async()=>({status:200,body:{language:'en'}})};
      assert.equal(await handleLanguagePreferencePage(request,response,service,'https://studenthub.invalid',(code)=>{status=code;},async()=> 'ar'),true);
      assert.equal(status,303,'LANGUAGE_HISTORY_INLINE_200_MUTANT native Preview must redirect');`;
    const run = () => spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 10_000 });
    writeFileSync(modulePath, original);
    const baseline = run(); assert.equal(baseline.error, undefined); assert.equal(baseline.status, 0, baseline.stderr);
    writeFileSync(modulePath, original.replace(from, to));
    const mutant = run(); assert.equal(mutant.error, undefined); assert.equal(mutant.status, 1, mutant.stderr);
    assert.match(mutant.stderr, /AssertionError/); assert.match(mutant.stderr, /LANGUAGE_HISTORY_INLINE_200_MUTANT native Preview must redirect/);
    assert.doesNotMatch(mutant.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("LANGUAGE_HISTORY_LOOKUP_PRECEDENCE failed display lookup cannot mask malformed query or service refusal", async (t) => {
  const x = await localizedGateway(t);
  x.controls.failRead = true;
  for (const query of ["", "language=en&locale=ar", "language=en&language=ar"]) {
    const response = await x.getReview("ar", query), document = await response.text();
    assert.equal(response.status, 400);
    assert.match(document, /<html lang="en" dir="ltr">/);
    assert.doesNotMatch(document, /SYNTHETIC-PRIVATE|name="token\./);
  }
  for (const status of [401, 403, 409, 503] as const) {
    x.app.preferences = { ...x.service, preview: async () => ({ status, body: { error: "SYNTHETIC-PRIVATE-ERROR" } }) };
    const response = await x.getReview("ar"), document = await response.text();
    assert.equal(response.status, status, "fresh GET preserves the authoritative service refusal");
    assert.match(document, /<html lang="en"(?: dir="ltr")?>/);
    assert.doesNotMatch(document, /SYNTHETIC-PRIVATE|name="token\./);
  }
  x.app.preferences = undefined;
  const missing = await x.getReview("ar"), document = await missing.text();
  assert.equal(missing.status, 503); assert.match(document, /The profile service is unavailable/);
  assert.doesNotMatch(document, /SYNTHETIC-PRIVATE|name="token\./);
  assert.equal(x.controls.commits, 0);
});

test("LANGUAGE_HISTORY_SHARED_VALIDATION both preview entry points preserve exact-body and authentication precedence", async () => {
  const session = "v".repeat(43), personId = "synthetic-validation-person";
  let writerCalls = 0, clockCalls = 0, commits = 0;
  const service = createLanguagePreference({
    sessions: { get: async (id) => id === session ? { id, personId } : undefined },
    store: {
      forPrincipal: (principalId) => {
        writerCalls++;
        assert.equal(principalId, personId);
        return {
          ownedRecord: (ref) => ref === safeWritePrincipalRef(personId) ? personRecordRef(personId) : null,
          readField: () => null,
          commit: () => { commits++; return { ok: false, reason: "not_own_record" }; },
        };
      },
      readReceipt: async () => null,
    },
    clock: { now: () => { clockCalls++; return new Date("2026-11-05T08:00:00Z"); } },
    secret: "synthetic-preview-validation-secret-at-least-32-bytes",
  });
  const malformedBodies: unknown[] = [
    undefined, null, "language=en", [], ["en"], {}, { locale: "en" },
    { language: "en", locale: "ar" }, { language: "en", token: {} },
    { language: "xx", extra: true },
  ];
  const invalidValues: unknown[] = [undefined, null, "", "xx", "EN", "ar-KW", " en", "en ", 1, true, [], {}];
  for (const method of ["validatePreview", "preview"] as const) {
    for (const body of malformedBodies) {
      assert.deepEqual(await service[method](session, body), { status: 400, body: { error: "invalid_request" } }, method);
    }
    for (const value of invalidValues) {
      assert.deepEqual(await service[method](session, { language: value }), { status: 400, body: { error: "invalid_value" } }, method);
    }
    for (const sessionId of [undefined, "missing-session"]) {
      for (const body of [...malformedBodies, ...invalidValues.map((language) => ({ language })), { language: "en" }]) {
        assert.deepEqual(await service[method](sessionId, body), { status: 401, body: { error: "unauthorized" } }, `${method} authenticates before reporting body errors`);
      }
    }
  }
  assert.equal(writerCalls, 0, "invalid and unauthorized requests never enter safe-write");
  assert.equal(clockCalls, 0);
  for (const language of ["en", "ar"]) {
    assert.deepEqual(await service.validatePreview(session, { language }), { status: 200, body: { language } });
  }
  assert.equal(writerCalls, 0, "native POST validation never builds a writer or issues a discarded token");
  assert.equal(clockCalls, 0, "native POST validation never reads the token issuance clock");
  const preview = await service.preview(session, { language: "en" });
  assert.equal(preview.status, 200);
  assert.deepEqual(Object.keys(preview.body as object).sort(), ["changes", "token"]);
  assert.equal(writerCalls, 1, "the shared validator still permits JSON and GET preview to issue a token");
  assert.ok(clockCalls > 0);
  assert.equal(commits, 0);
});
