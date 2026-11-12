// The civil ID suggestion line on My profile, accept and dismiss, through the
// real gateway: every test serves My profile with startRealProfileServer (the
// production composition over in-memory stores) and adds the suggestion
// service with composeCivilIdSuggestion, the function wireProfile itself calls.
// Expected counts, id lists and messages are taken from the running code.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  CIVIL_ID_MESSAGES,
  CivilIdVault,
  FakeCivilIdOcrReader,
  InMemoryCivilIdOcrStore,
  SYNTHETIC_PROFILE_FIXTURES,
  kuwaitDate,
  runCivilIdOcr,
} from "@studenthub/profile";
import { composeCivilIdSuggestion } from "../src/wiring/profile.js";
import { REAL_PROFILE_CIVIL_KEY, REAL_PROFILE_OTHER_PERSON, REAL_PROFILE_PERSON as PERSON, startRealProfileServer } from "./helpers/real-profile-server.js";

const NUMBER = "123456781234";
const NOW = () => new Date("2026-11-12T09:00:00.000Z");
const TODAY = kuwaitDate(NOW());
// Not expired: one year after the test's own Asia/Kuwait date.
const NEXT_YEAR = `${Number(TODAY.slice(0, 4)) + 1}${TODAY.slice(4)}`;
const PAST = "2020-01-05";
const ACCEPT = "/profile/civil-id/suggestion/accept";
const DISMISS = "/profile/civil-id/suggestion/dismiss";
const vault = new CivilIdVault(Buffer.from(REAL_PROFILE_CIVIL_KEY, "base64"));
type Job = InMemoryCivilIdOcrStore["jobs"][number];
type Options = { number?: string; country?: "KW" | "BH"; expiry?: string; status?: Job["status"]; ocrStore?: InMemoryCivilIdOcrStore; seed?: boolean; feature?: boolean };

const S1 = "5f0c2a1e-8d3b-4c7a-9e21-3b6d4f8a1c01", S2 = "5f0c2a1e-8d3b-4c7a-9e21-3b6d4f8a1c02", STALE = "5f0c2a1e-8d3b-4c7a-9e21-3b6d4f8a1c99";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function job(id: string, o: Options = {}): Job {
  const number = o.number ?? NUMBER, country = o.country ?? "KW", sealed = vault.seal(PERSON, country, number), at = NOW().toISOString();
  return { id, principalId: PERSON, side: "front", documentId: "doc", version: `${id}-v`, size: 12, status: o.status ?? "read", attempts: 1, notBefore: at,
    leaseOwner: null, leaseExpiresAt: null, failureCode: null, country, numberCiphertext: sealed.ciphertext, keyVersion: sealed.keyVersion,
    last4: number.slice(-4), expiry: o.expiry ?? NEXT_YEAR, fallbackVersion: null, supersededAt: null, resolved: null, createdAt: at, updatedAt: at } as Job;
}

async function setup(t: TestContext, o: Options = {}) {
  const store = o.ocrStore ?? new InMemoryCivilIdOcrStore();
  if (o.seed !== false) store.jobs.push(job(S1, o));
  let reads = 0;
  let service: ReturnType<typeof composeCivilIdSuggestion> | undefined;
  const server = await startRealProfileServer(t, { row: SYNTHETIC_PROFILE_FIXTURES.unavailable, now: NOW, extend: (s) => {
    if (o.feature === false) return {};
    const raw = composeCivilIdSuggestion({ store, civilId: s.civilId, civilStore: s.civilStore, vault: s.vault, now: s.now });
    service = { ...raw, current: async (id: string) => { reads++; return raw.current(id); } };
    return { civilIdSuggestion: service } as never;
  } });
  const open = () => store.jobs.find((entry) => !entry.resolved && !entry.supersededAt)?.id ?? S1;
  const form = (id = open()) => ({ suggestionId: id, submissionId: id });
  return {
    ...server, store, service: service!, form,
    get reads() { return reads; },
    resetReads() { reads = 0; },
    page: async (path = "/profile") => (await server.get(path)).text(),
    accept: (body: Record<string, string> = form()) => server.post(ACCEPT, body),
    dismiss: (body: Record<string, string> = form()) => server.post(DISMISS, body),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const rowIds = (html: string) => [...html.matchAll(/<div id="field-([^"]+)" class="p-row"/g)].map((match) => match[1]);
const markers = (html: string) => (html.match(/data-state="unavailable"/g) ?? []).length;
const suggestionRows = (html: string) => (html.match(/<dt>Civil ID photo<\/dt>/g) ?? []).length;

// Refusals that must save nothing and leave the suggestion open.
async function refusals(t: TestContext, token: string) {
  const duplicate = await setup(t);
  await duplicate.civilId.save({ principalId: REAL_PROFILE_OTHER_PERSON, submissionId: "holder-entry", revision: 0, country: "KW", number: NUMBER, expiry: NEXT_YEAR });
  const before = duplicate.civilStore.events.length, refused = await duplicate.accept();
  assert.equal(refused.status, 409, `${token} duplicate number is 409`);
  assert.ok((await refused.text()).includes(CIVIL_ID_MESSAGES.duplicate), `${token} duplicate shows CIV's duplicate message`);
  assert.equal(duplicate.civilStore.events.length, before, `${token} duplicate saves nothing`);
  assert.equal(duplicate.store.jobs[0]!.resolved, null, `${token} duplicate leaves the suggestion open`);
  for (const [o, label] of [[{ number: "12345671234", country: "KW" }, "short Kuwait number"], [{ number: "12345678", country: "BH" }, "short Bahrain number"]] as const) {
    const f = await setup(t, o), r = await f.accept();
    assert.equal(r.status, 400, `${token} ${label} is 400`);
    assert.ok((await r.text()).includes(CIVIL_ID_MESSAGES.invalid_number), `${token} ${label} shows CIV's number message`);
    assert.equal(f.civilStore.events.length, 0, `${token} ${label} saves nothing`);
    assert.equal(f.store.jobs[0]!.resolved, null, `${token} ${label} leaves the suggestion open`);
  }
  const expired = await setup(t, { expiry: PAST }), r = await expired.accept();
  assert.equal(r.status, 409, `${token} an expired date cannot be accepted`);
  assert.equal(expired.civilStore.events.length, 0, `${token} an expired date saves nothing`);
  assert.equal(expired.store.jobs[0]!.resolved, null, `${token} an expired date leaves the suggestion open`);
}

test("OCRP_LINE a read suggestion shows the masked line with exactly two forms under the Civil ID row", async (t) => {
  const f = await setup(t), html = await f.page();
  assert.ok(html.includes(`We read a number ending 1234, expiring ${NEXT_YEAR}. Is this right?`), "OCRP_LINE shows the read line");
  assert.match(html, /id="field-civilId"[\s\S]*?<\/div><\/dd><\/div><div class="p-row"><dt>Civil ID photo<\/dt>/, "OCRP_LINE line directly under the Civil ID row");
  assert.equal((html.match(/action="\/profile\/civil-id\/suggestion\/accept"/g) ?? []).length, 1, "OCRP_LINE one accept form");
  assert.equal((html.match(/action="\/profile\/civil-id\/suggestion\/dismiss"/g) ?? []).length, 1, "OCRP_LINE one dismiss form");
  assert.equal(html.split(`<input type="hidden" name="suggestionId" value="${S1}">`).length - 1, 2, "OCRP_LINE each form carries the suggestion id");
  assert.equal(html.split(`<input type="hidden" name="submissionId" value="${S1}">`).length - 1, 2, "OCRP_LINE each form carries the derived submission id");
  for (const [, value] of html.matchAll(/name="submissionId" value="([^"]*)"/g)) assert.match(value!, UUID, "OCRP_LINE the submission id is a uuid, as the civil ID event table requires");
  assert.ok(!html.includes(NUMBER), "OCRP_LINE the full number never renders");
});

test("OCRP_LINE an expired date shows the passed-date line with only the dismiss form", async (t) => {
  const html = await (await setup(t, { expiry: PAST })).page();
  assert.ok(html.includes(`The date we read (${PAST}) has passed.`), "OCRP_LINE passed-date line");
  assert.equal((html.match(/suggestion\/accept/g) ?? []).length, 0, "OCRP_LINE an expired date has no accept form");
  assert.equal((html.match(/suggestion\/dismiss/g) ?? []).length, 1, "OCRP_LINE an expired date keeps the dismiss form");
});

test("OCRP_LINE unreadable and failed show the type-it-yourself line; pending, running, answered, none and feature off render nothing", async (t) => {
  for (const status of ["unreadable", "failed"] as const) {
    const html = await (await setup(t, { status })).page();
    assert.ok(html.includes("We could not read your photo. Please type your civil ID number and expiry."), `OCRP_LINE ${status} shows the type-it-yourself line`);
  }
  const baseline = await (await setup(t, { feature: false })).page();
  assert.equal(markers(baseline), 19, "OCRP_LINE the unavailable projection keeps 19 unavailable markers");
  const answered = await setup(t);
  answered.store.jobs[0]!.resolved = "accepted";
  const quiet = { pending: await (await setup(t, { status: "pending" })).page(), running: await (await setup(t, { status: "running" })).page(),
    answered: await answered.page(), none: await (await setup(t, { seed: false })).page(), off: baseline };
  for (const [label, html] of Object.entries(quiet)) {
    assert.equal(suggestionRows(html), 0, `OCRP_LINE ${label} renders no suggestion row`);
    assert.deepEqual(rowIds(html), rowIds(baseline), `OCRP_LINE ${label} keeps every row`);
    assert.equal(markers(html), markers(baseline), `OCRP_LINE ${label} keeps every unavailable marker`);
  }
});

test("OCRP_ACCEPT accept saves through CIV, sets needs_review, resolves and shows the waiting state", async (t) => {
  const f = await setup(t), r = await f.accept();
  assert.equal(r.status, 303, "OCRP_ACCEPT redirects");
  assert.equal(r.headers.get("location"), "/profile#field-civilId", "OCRP_ACCEPT returns to the Civil ID row");
  assert.equal(f.civilStore.events.length, 1, "OCRP_ACCEPT saves once through CIV");
  const own = await f.civilId.readOwn(PERSON);
  assert.ok(own?.maskedNumber?.endsWith("1234"), "OCRP_ACCEPT the civil ID holds the read number");
  assert.equal(own?.expiry, NEXT_YEAR, "OCRP_ACCEPT the civil ID holds the read expiry");
  assert.equal(own?.needsReview, true, "OCRP_ACCEPT the civil ID waits for a staff check");
  assert.equal(f.store.jobs[0]!.resolved, "accepted", "OCRP_ACCEPT the suggestion is marked accepted");
  const html = await f.page();
  assert.ok(html.includes("Waiting for StudentHub to check"), "OCRP_ACCEPT the page shows the waiting state");
  assert.equal(suggestionRows(html), 0, "OCRP_ACCEPT the line is gone");
});

test("OCRP_ACCEPT refusals keep CIV's messages, save nothing and leave the suggestion open", async (t) => refusals(t, "OCRP_ACCEPT"));

test("OCRP_STALE a retry saves once; not-current, replaced, answered and foreign ids are 409", async (t) => {
  const f = await setup(t);
  assert.equal((await f.accept()).status, 303, "OCRP_STALE first accept redirects");
  assert.equal((await f.accept(f.form(S1))).status, 303, "OCRP_STALE a retry of the same form redirects");
  assert.equal(f.civilStore.events.length, 1, "OCRP_STALE a retry saves once");
  assert.equal(f.civilStore.events[0]!.submissionId, S1, "OCRP_STALE the submission id is derived from the suggestion");
  const wrong = await setup(t), notCurrent = await wrong.accept(wrong.form(STALE));
  assert.equal(notCurrent.status, 409, "OCRP_STALE a not-current id is 409");
  assert.ok((await notCurrent.text()).includes(CIVIL_ID_MESSAGES.stale_revision), "OCRP_STALE a not-current id shows CIV's stale message");
  assert.equal((await wrong.dismiss(wrong.form(STALE))).status, 409, "OCRP_STALE a not-current id cannot be dismissed");
  const replaced = await setup(t);
  replaced.store.jobs[0]!.supersededAt = NOW().toISOString();
  assert.equal((await replaced.accept(replaced.form(S1))).status, 409, "OCRP_STALE a replaced photo version is 409");
  const answered = await setup(t);
  assert.equal((await answered.dismiss()).status, 303);
  assert.equal((await answered.accept(answered.form(S1))).status, 409, "OCRP_STALE an answered suggestion is 409");
  const foreign = await setup(t);
  foreign.store.jobs[0]!.principalId = REAL_PROFILE_OTHER_PERSON;
  assert.equal((await foreign.accept(foreign.form(S1))).status, 409, "OCRP_STALE another person's suggestion cannot be accepted");
  assert.equal((await foreign.dismiss(foreign.form(S1))).status, 409, "OCRP_STALE another person's suggestion cannot be dismissed");
  for (const g of [wrong, replaced, answered, foreign]) assert.equal(g.civilStore.events.length, 0, "OCRP_STALE refused ids save nothing");
  assert.equal(foreign.store.jobs[0]!.resolved, null, "OCRP_STALE another person's suggestion stays open");
});

test("OCRP_DISMISS dismiss resolves without a civil ID write; the same version stays hidden, a later one shows", async (t) => {
  const f = await setup(t), r = await f.dismiss();
  assert.equal(r.status, 303, "OCRP_DISMISS redirects");
  assert.equal(r.headers.get("location"), "/profile/civil-id", "OCRP_DISMISS goes to the Civil ID form");
  assert.equal(f.store.jobs[0]!.resolved, "dismissed", "OCRP_DISMISS records dismissed");
  assert.equal(f.civilStore.events.length, 0, "OCRP_DISMISS writes no civil ID");
  assert.equal(await f.civilId.readOwn(PERSON), null, "OCRP_DISMISS leaves the civil ID empty");
  assert.equal(suggestionRows(await f.page()), 0, "OCRP_DISMISS the same version stays hidden");
  f.store.jobs.push(job(S2));
  assert.ok((await f.page()).includes("We read a number ending 1234"), "OCRP_DISMISS a later version shows");
});

test("OCRP_ORIGIN only same-origin cookie posts with exact fields reach the service", async (t) => {
  const f = await setup(t), body = new URLSearchParams(f.form()).toString(), headers = { origin: "https://studenthub.test.invalid", "content-type": "application/x-www-form-urlencoded" };
  const none = await fetch(f.url + ACCEPT, { method: "POST", redirect: "manual", headers, body });
  assert.equal(none.status, 401, "OCRP_ORIGIN no session is 401");
  assert.match(await none.text(), /Sign in again to continue safely\./, "OCRP_ORIGIN no session shows the sign-in page");
  const bearer = await fetch(f.url + ACCEPT, { method: "POST", redirect: "manual", headers: { ...headers, authorization: "Bearer synthetic" }, body });
  assert.equal(bearer.status, 401, "OCRP_ORIGIN a Bearer header alone is refused");
  const cross = await fetch(f.url + ACCEPT, { method: "POST", redirect: "manual", headers: { ...headers, cookie: f.cookie(), "sec-fetch-site": "cross-site" }, body });
  assert.equal(cross.status, 403, "OCRP_ORIGIN cross-site is 403");
  const wrong = await fetch(f.url + ACCEPT, { method: "POST", redirect: "manual", headers: { ...headers, cookie: f.cookie(), origin: "https://evil.invalid" }, body });
  assert.equal(wrong.status, 403, "OCRP_ORIGIN a wrong Origin is 403");
  const extra = await f.accept({ ...f.form(), personId: PERSON });
  assert.equal(extra.status, 400, "OCRP_ORIGIN an extra field is 400");
  const missing = await f.accept({ suggestionId: S1 });
  assert.equal(missing.status, 400, "OCRP_ORIGIN a missing field is 400");
  for (const r of [none, bearer, cross, wrong, extra, missing]) assert.equal(r.headers.get("cache-control"), "no-store", "OCRP_ORIGIN every answer is no-store");
  assert.equal(f.reads, 0, "OCRP_ORIGIN refused posts never read the suggestion");
  assert.equal(f.civilStore.events.length, 0, "OCRP_ORIGIN refused posts save nothing");
  assert.equal(f.store.jobs[0]!.resolved, null, "OCRP_ORIGIN refused posts leave the suggestion open");
});

test("OCRP_SECRECY the plain number appears in no field, redirect, body, header or log", async (t) => {
  const logged: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) t.mock.method(console, method, (...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  const seen: string[] = [];
  const record = async (r: Response) => { seen.push(String(r.status), JSON.stringify([...r.headers]), await r.text()); };
  const accepted = await setup(t);
  seen.push(await accepted.page());
  await record(await accepted.accept());
  seen.push(await accepted.page());
  const duplicate = await setup(t);
  await duplicate.civilId.save({ principalId: REAL_PROFILE_OTHER_PERSON, submissionId: "holder", revision: 0, country: "KW", number: NUMBER, expiry: NEXT_YEAR });
  await record(await duplicate.accept());
  await record(await duplicate.accept(duplicate.form(STALE)));
  const dismissed = await setup(t);
  await record(await dismissed.dismiss());
  for (const text of [...seen, ...logged]) assert.ok(!text.includes(NUMBER), "OCRP_SECRECY the plain number never leaves the server");
  assert.doesNotMatch(seen.join(""), /name="number"/, "OCRP_SECRECY no form carries a number field");
  const root = new URL("../src/", import.meta.url), opens: string[] = [];
  const visit = async (dir: URL): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) await visit(url);
      else if (entry.name.endsWith(".js")) for (const _ of (await readFile(url, "utf8")).matchAll(/\.vault\.open\(/g)) opens.push(url.pathname.slice(root.pathname.length));
    }
  };
  await visit(root);
  assert.deepEqual(opens, ["civil-id-suggestion-http.js"], "OCRP_SECRECY the sealed number is opened once, in the accept handler");
});

test("OCRP_SHOWN a worker-read suggestion shows, and after accept the Civil ID row shows the masked number, expiry and waiting state", async (t) => {
  const store = new InMemoryCivilIdOcrStore(), photo = { principalId: PERSON, side: "front" as const, documentId: "doc", version: "worker-v1", size: 3 };
  const [year, month, day] = NEXT_YEAR.split("-");
  await store.beginSweep([], new Date(NOW().getTime() - 360_000).toISOString());
  await runCivilIdOcr({ store, photos: { list: async () => [photo], read: async () => ({ bytes: Buffer.from("img"), mime: "image/jpeg" }) },
    reader: new FakeCivilIdOcrReader([NUMBER, `${day}/${month}/${year}`]), vault, clock: { now: NOW }, workerId: randomUUID(), leaseMs: 1000, batchSize: 1 });
  const f = await setup(t, { ocrStore: store, seed: false });
  assert.ok((await f.page()).includes(`We read a number ending 1234, expiring ${NEXT_YEAR}. Is this right?`), "OCRP_SHOWN the worker's suggestion shows");
  assert.equal((await f.accept()).status, 303, "OCRP_SHOWN the worker's suggestion can be accepted");
  assert.match(await f.page(), new RegExp(`•••• •••• 1234, expires ${NEXT_YEAR}</bdi><p class="p-meta">Waiting for StudentHub to check`), "OCRP_SHOWN the Civil ID row shows the accepted values waiting");
});

test("OCRP_SHOWN My profile makes exactly one suggestion read whatever the earlier jobs", async (t) => {
  const f = await setup(t);
  f.store.jobs.unshift({ ...job("old-1"), resolved: "dismissed" }, { ...job("old-2"), supersededAt: NOW().toISOString() }, job("old-3", { status: "failed" }));
  f.resetReads();
  await f.page();
  assert.equal(f.reads, 1, "OCRP_SHOWN one suggestion read per My profile render");
});

test("OCRP_SEAM HTML reads once; JSON, other pages and another person's profile read nothing; a throwing read keeps the page", async (t) => {
  const f = await setup(t);
  f.resetReads();
  await f.page();
  assert.equal(f.reads, 1, "OCRP_SEAM HTML My profile reads once");
  f.resetReads();
  await fetch(f.url + "/profile", { headers: { accept: "application/json", cookie: f.cookie() } });
  assert.equal(f.reads, 0, "OCRP_SEAM JSON My profile reads nothing");
  for (const path of ["/profile/civil-id", "/profile/documents", "/profile/area"]) {
    f.resetReads();
    await (await f.get(path)).text();
    assert.equal(f.reads, 0, `OCRP_SEAM ${path} reads nothing`);
  }
  f.resetReads();
  await f.page(`/profile?person_id=${REAL_PROFILE_OTHER_PERSON}`);
  assert.equal(f.reads, 0, "OCRP_SEAM another person's profile reads nothing");
  f.service.current = async () => { throw new Error("offline"); };
  const failed = await f.get("/profile");
  assert.equal(failed.status, 200, "OCRP_SEAM a throwing read keeps My profile");
  assert.equal(suggestionRows(await failed.text()), 0, "OCRP_SEAM a throwing read shows no line");
});

test("OCRP_GATE the read is for the signed-in person only", async (t) => {
  const f = await setup(t);
  f.resetReads();
  assert.ok((await f.page()).includes("We read a number ending 1234"), "OCRP_GATE own My profile shows the line");
  assert.ok((await f.page(`/profile?person_id=${PERSON}`)).includes("We read a number ending 1234"), "OCRP_GATE own person_id shows the line");
  assert.equal(f.reads, 2, "OCRP_GATE one read per own page");
  await f.page(`/profile?person_id=${REAL_PROFILE_OTHER_PERSON}`);
  assert.equal(f.reads, 2, "OCRP_GATE another person's person_id makes no read");
});

test("OCRP_PLACE the line is a row of the personal definition list right after Civil ID, with the area configured", async (t) => {
  const html = await (await setup(t)).page();
  const personal = /<section id="section-personal"[\s\S]*?<dl class="p-fields">([\s\S]*?)<\/dl><\/section>/.exec(html)?.[1] ?? "";
  assert.match(personal, /<div id="field-area" class="p-row"/, "OCRP_PLACE the area row is on the page");
  assert.match(personal, /<div id="field-civilId" class="p-row"[\s\S]*?<\/div><\/dd><\/div><div class="p-row"><dt>Civil ID photo<\/dt><dd>/, "OCRP_PLACE directly after Civil ID inside dl.p-fields");
  assert.equal(suggestionRows(html), 1, "OCRP_PLACE exactly one suggestion row");
});

test("OCRP_ROWS every existing row keeps its order, markup and unavailable marker", async (t) => {
  const baseline = await (await setup(t, { feature: false })).page(), shown = await (await setup(t)).page();
  assert.ok(rowIds(baseline).length > 0, "OCRP_ROWS the baseline page has rows");
  assert.deepEqual(rowIds(shown), rowIds(baseline), "OCRP_ROWS the row ids and their order are unchanged");
  assert.equal(markers(shown), markers(baseline), "OCRP_ROWS the unavailable markers are unchanged");
  assert.equal(shown.replace(/<div class="p-row"><dt>Civil ID photo<\/dt>[\s\S]*?<\/dd><\/div>/, ""), baseline, "OCRP_ROWS removing the line gives the page without it");
});

test("OCRP_CASES refusals keep CIV's messages, save nothing and leave the suggestion open", async (t) => refusals(t, "OCRP_CASES"));

test("OCRP_CASES raced and sequential double accepts both redirect with one save", async (t) => {
  const raced = await setup(t), [a, b] = await Promise.all([raced.accept(), raced.accept()]);
  assert.deepEqual([a.status, b.status], [303, 303], "OCRP_CASES raced accepts both redirect");
  assert.equal(raced.civilStore.events.length, 1, "OCRP_CASES raced accepts save once");
  const sequential = await setup(t);
  assert.equal((await sequential.accept()).status, 303);
  assert.equal((await sequential.accept(sequential.form(S1))).status, 303, "OCRP_CASES a sequential retry redirects");
  assert.equal(sequential.civilStore.events.length, 1, "OCRP_CASES a sequential retry saves once");
});

test("OCRP_CASES values already on file resolve with 303, then a retry is 409", async (t) => {
  const f = await setup(t);
  await f.civilId.save({ principalId: PERSON, submissionId: "manual-entry", revision: 0, country: "KW", number: NUMBER, expiry: NEXT_YEAR });
  const count = f.civilStore.events.length;
  assert.equal((await f.accept()).status, 303, "OCRP_CASES values on file redirect");
  assert.equal(f.store.jobs[0]!.resolved, "accepted", "OCRP_CASES values on file resolve the suggestion");
  assert.equal(f.civilStore.events.length, count, "OCRP_CASES values on file save nothing");
  assert.equal((await f.accept(f.form(S1))).status, 409, "OCRP_CASES a retry after values on file is 409");
});

test("OCRP_CASES replaced and dismissed versions; no session, Bearer-only, missing field and cross-site each save nothing", async (t) => {
  const replaced = await setup(t);
  replaced.store.jobs[0]!.supersededAt = NOW().toISOString();
  assert.equal((await replaced.accept(replaced.form(S1))).status, 409, "OCRP_CASES a replaced version is 409");
  const dismissed = await setup(t);
  await dismissed.dismiss();
  assert.equal(suggestionRows(await dismissed.page()), 0, "OCRP_CASES a dismissed version does not return");
  dismissed.store.jobs.push(job(S2));
  assert.equal(suggestionRows(await dismissed.page()), 1, "OCRP_CASES a later version shows");
  const f = await setup(t), body = new URLSearchParams(f.form()).toString(), headers = { origin: "https://studenthub.test.invalid", "content-type": "application/x-www-form-urlencoded" };
  assert.equal((await fetch(f.url + ACCEPT, { method: "POST", redirect: "manual", headers, body })).status, 401, "OCRP_CASES no session is 401");
  assert.equal((await fetch(f.url + ACCEPT, { method: "POST", redirect: "manual", headers: { ...headers, authorization: "Bearer synthetic" }, body })).status, 401, "OCRP_CASES Bearer-only is 401");
  assert.equal((await f.accept({ suggestionId: S1 })).status, 400, "OCRP_CASES a missing field is 400");
  assert.equal((await f.accept({ suggestionId: "not-a-uuid", submissionId: "not-a-uuid" })).status, 400, "OCRP_CASES a suggestion id that is not a uuid is 400");
  assert.equal((await fetch(f.url + ACCEPT, { method: "POST", redirect: "manual", headers: { ...headers, cookie: f.cookie(), "sec-fetch-site": "cross-site" }, body })).status, 403, "OCRP_CASES cross-site is 403");
  for (const g of [replaced, dismissed, f] as Setup[]) assert.equal(g.civilStore.events.length, 0, "OCRP_CASES refused requests save nothing");
  assert.equal(f.store.jobs[0]!.resolved, null, "OCRP_CASES refused requests leave the suggestion open");
});
