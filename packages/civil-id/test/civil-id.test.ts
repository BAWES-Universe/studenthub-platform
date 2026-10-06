import assert from "node:assert/strict";
import { after, test } from "node:test";
import { inspect } from "node:util";
import { principalAuditRef } from "@studenthub/db";
import { CIVIL_ID_FIXTURES as f, InMemoryCivilIdStore, civilIdFixture } from "../src/fixtures.js";
import { CivilIdError, normalizeCivilId } from "../src/format.js";
import { isCivilIdValidOn } from "../src/expiry-gate.js";
import { CIVIL_ID_DECISIONS } from "../src/decisions.js";
import { confirmCivilId, listCivilIdReviewQueue, runCivilIdOcrJob, setOwnCivilId, type CivilIdDependencies } from "../src/verification.js";

const captured: string[] = [];
const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
for (const key of Object.keys(originals) as (keyof typeof originals)[]) {
  console[key] = (...args: unknown[]) => { captured.push(inspect(args)); };
}
function assertNoLeaks() {
  const output = captured.join("\n");
  for (const value of [f.number, f.otherNumber, f.bhNumber]) assert.ok(!output.includes(value), "private number leaked");
}
after(() => {
  Object.assign(console, originals);
  assertNoLeaks();
});
const identity = (principalId: string) => ({ kind: "principal" as const, principalId });
const input = (person = f.P as string, number = f.number as string) => ({ identity: identity(person),
  countryCode: "KW", civilIdNumber: number, expiryDate: f.expiryDate });
const job = (jobId = "job-1", candidateRef = f.P as string) => ({ jobId, candidateRef, frontImage: new Uint8Array([0]) });
const ocr = (civilIdNumber = f.number as string, expiryDate = f.expiryDate as string) => ({
  readCivilId: async () => ({ countryCode: "KW", civilIdNumber, expiryDate }),
});
async function refused(work: Promise<unknown>, code: string) {
  await assert.rejects(work, (error: unknown) => {
    captured.push(inspect(error));
    assert.ok(error instanceof CivilIdError);
    assert.equal(error.message, code);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    return true;
  });
}
async function setup() {
  const store = new InMemoryCivilIdStore();
  const deps = await civilIdFixture(store);
  return { store, deps };
}
function audit(store: InMemoryCivilIdStore) { captured.push(JSON.stringify(store.audits)); }

test("SHU-146/AC-01 reregister-after-delete", async () => {
  const { store, deps } = await setup();
  await setOwnCivilId(input(), deps);
  await refused(setOwnCivilId(input(f.Q), deps), "civil_id_duplicate");
  assert.equal(store.rows.has(f.Q), false);
  assert.equal(store.audits.length, 1);
  // Synthetic stand-in for the separately owned candidate lifecycle operation.
  store.rows.set(f.P, { ...store.rows.get(f.P)!, candidateDeleted: true });
  await assert.doesNotReject(setOwnCivilId(input(f.Q), deps));
  assert.equal(store.rows.get(f.Q)?.civilIdNumber, f.number);
  await refused(setOwnCivilId(input(f.P, f.otherNumber), deps), "not_found");
  assert.deepEqual((await listCivilIdReviewQueue(identity(f.S), deps)).map((row) => row.candidateRef), [f.Q]);
  audit(store);
});

test("SHU-146/AC-02 job-idempotent", async () => {
  const { store, deps } = await setup();
  let calls = 0;
  const port = { readCivilId: async () => { calls++; return ocr().readCivilId(); } };
  const results = await Promise.all([runCivilIdOcrJob(job(), { ...deps, ocr: port }), runCivilIdOcrJob(job(), { ...deps, ocr: port })]);
  assert.deepEqual(results.map((r) => r.kind), ["processed", "already_processed"]);
  assert.equal(calls, 1);
  assert.equal(store.rows.get(f.P)?.revision, 1);
  assert.equal(store.jobs.size, 1);
  assert.equal(store.audits.length, 1);
  await refused(runCivilIdOcrJob(job("job-1", f.Q), { ...deps, ocr: port }), "civil_id_request_invalid");
  assert.equal(calls, 1);
  audit(store);
});

test("SHU-146/AC-03 ocr-sets-need-verification", async () => {
  const { store, deps } = await setup();
  await runCivilIdOcrJob(job(), { ...deps, ocr: ocr() });
  assert.equal(store.rows.get(f.P)?.needVerification, true);
  assert.equal(store.rows.get(f.P)?.source, "ocr");
  await confirmCivilId({ identity: identity(f.S), candidateRef: f.P, expectedRevision: 1 }, deps);
  await setOwnCivilId(input(), deps);
  assert.equal(store.rows.get(f.P)?.needVerification, true);
  assert.equal(store.rows.get(f.P)?.source, "manual");
  assert.deepEqual((await listCivilIdReviewQueue(identity(f.S), deps)).map((row) => row.candidateRef), [f.P]);
  await refused(confirmCivilId({ identity: identity(f.S), candidateRef: f.P, expectedRevision: 1 }, deps), "civil_id_review_changed");
  assert.equal(store.rows.get(f.P)?.needVerification, true);
  await confirmCivilId({ identity: identity(f.S), candidateRef: f.P, expectedRevision: 3 }, deps);
  assert.deepEqual(await listCivilIdReviewQueue(identity(f.S), deps), []);
  audit(store);
});

test("SHU-146/AC-04 expiry-boundary", async () => {
  assert.equal(CIVIL_ID_DECISIONS.timeZone, "Asia/Kuwait");
  assert.equal(isCivilIdValidOn(f.expiryDate, new Date("2026-10-05T20:59:59.999Z")), true);
  assert.equal(isCivilIdValidOn(f.expiryDate, new Date("2026-10-05T21:00:00.000Z")), false);
  assert.equal(isCivilIdValidOn(f.expiryDate, new Date("2026-10-05T23:00:00Z")), false);
  assert.equal(isCivilIdValidOn(f.expiryDate, new Date("2026-10-05T23:00:00Z"), "UTC"), true);
  assert.equal(isCivilIdValidOn("2024-02-29", new Date("2024-02-29T12:00:00Z")), true);
  for (const bad of ["2026-02-29", "2026-04-31", "2026-1-01", "0000-01-01", "infinity", null]) {
    assert.equal(isCivilIdValidOn(bad, new Date(f.now)), false);
  }
  assert.equal(isCivilIdValidOn(f.expiryDate, new Date("bad")), false);
  assert.equal(isCivilIdValidOn(f.expiryDate, new Date(f.now), "bad-zone"), false);
  const { store, deps } = await setup();
  const result = await runCivilIdOcrJob(job(), { ...deps, ocr: ocr(f.number, "2026-10-04") });
  assert.equal(result.job.expired, true);
  assert.equal(result.job.status, "succeeded");
  assert.equal(store.rows.get(f.P)?.needVerification, true);
  assert.equal(isCivilIdValidOn(store.rows.get(f.P)?.expiryDate, deps.now()), false);
  audit(store);
});

test("SHU-146/AC-05 format-server-side", async () => {
  const { store, deps } = await setup();
  for (const number of ["28901011234", "2890101123456", "28901011234x", "28901 112345", "", null, 289010112345]) {
    await refused(setOwnCivilId({ ...input(), civilIdNumber: number }, deps), "civil_id_format_invalid");
  }
  for (const country of ["US", "kw", "toString", "__proto__", null]) {
    await refused(setOwnCivilId({ ...input(), countryCode: country }, deps), "civil_id_country_unsupported");
  }
  await refused(setOwnCivilId({ ...input(), expiryDate: "2026-02-30" }, deps), "civil_id_expiry_invalid");
  assert.equal(store.rows.size, 0);
  await setOwnCivilId({ ...input(), civilIdNumber: " ٢٨٩٠١٠١١٢٣٤٥ " }, deps);
  assert.equal(store.rows.get(f.P)?.civilIdNumber, f.number);
  assert.equal(normalizeCivilId("KW", "۲۸۹۰۱۰۱۱۲۳۴۵").civilIdNumber, f.number);
  await setOwnCivilId({ ...input(f.Q), countryCode: "BH", civilIdNumber: f.bhNumber }, deps);
  assert.equal(store.rows.get(f.Q)?.countryCode, "BH");
  await refused(setOwnCivilId({ ...input(f.Q), countryCode: "BH" }, deps), "civil_id_format_invalid");
  audit(store);
});

test("SHU-146/AC-06 staff-confirm-scope", async () => {
  const { store, deps } = await setup();
  await setOwnCivilId(input(), deps);
  for (const person of [f.U, f.P, f.Q, "self-staff", "unknown"]) {
    for (const candidateRef of [f.P, "missing"]) {
      await refused(confirmCivilId({ identity: identity(person), candidateRef, expectedRevision: 1 }, deps), "not_found");
    }
    await refused(listCivilIdReviewQueue(identity(person), deps), "not_found");
  }
  await confirmCivilId({ identity: identity(f.S), candidateRef: f.P, expectedRevision: 1 }, deps);
  assert.equal(store.rows.get(f.P)?.needVerification, false);
  assert.equal(store.rows.get(f.P)?.source, "staff");
  assert.equal(store.audits.at(-1)?.actorRef, principalAuditRef(f.S));
  await setOwnCivilId(input(), deps);
  await deps.authz.clearGrantsForPrincipal(f.S);
  await refused(confirmCivilId({ identity: identity(f.S), candidateRef: f.P, expectedRevision: 3 }, deps), "not_found");
  await confirmCivilId({ identity: identity("admin"), candidateRef: f.P, expectedRevision: 3 }, deps);
  assert.equal(store.rows.get(f.P)?.needVerification, false);
  audit(store);
});

test("SHU-146/AC-07 no-number-in-logs", async () => {
  const { store, deps } = await setup();
  await setOwnCivilId(input(), deps);
  // A value-bearing provider error must be discarded, even its cause.
  await runCivilIdOcrJob(job(), { ...deps, ocr: { readCivilId: async () => { throw new Error(f.number); } } });
  const broken: CivilIdDependencies = { ...deps, store: { transaction: async () => { throw new Error(f.otherNumber); } } };
  await refused(setOwnCivilId(input(), broken), "civil_id_unavailable");
  await refused(setOwnCivilId(input(f.Q), deps), "civil_id_duplicate");
  audit(store);
  for (const event of store.audits) {
    assert.match(event.actorRef, /^[0-9a-f]{64}$/);
    assert.match(event.candidateRefHash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(event).includes(f.P));
  }
  assertNoLeaks();
});

test("SHU-146/AC-08 ocr-failure-explicit", async () => {
  const { store, deps } = await setup();
  await setOwnCivilId(input(), deps);
  const original = structuredClone(store.rows.get(f.P));
  let calls = 0;
  const failing = { readCivilId: async () => { calls++; throw new Error(f.number); } };
  const first = await runCivilIdOcrJob(job(), { ...deps, ocr: failing });
  assert.equal(first.job.status, "failed");
  assert.equal(first.job.code, "civil_id_ocr_failed");
  assert.deepEqual(store.rows.get(f.P), original);
  assert.equal(store.jobs.get("job-1")?.status, "failed");
  assert.equal((await runCivilIdOcrJob(job(), { ...deps, ocr: failing })).kind, "already_processed");
  assert.equal(calls, 1);
  assert.equal(store.audits.length, 2);
  const unreadable = await runCivilIdOcrJob(job("unreadable"), { ...deps, ocr: { readCivilId: async () => null } });
  assert.equal(unreadable.job.code, "civil_id_ocr_unreadable");
  const malformed = await runCivilIdOcrJob(job("malformed"), { ...deps, ocr: { readCivilId: async () => ({}) } });
  assert.equal(malformed.job.status, "failed");
  assert.deepEqual(store.rows.get(f.P), original);
  const duplicate = await runCivilIdOcrJob(job("duplicate", f.Q), { ...deps, ocr: ocr() });
  assert.equal(duplicate.job.code, "civil_id_duplicate");
  assert.equal(store.rows.has(f.Q), false);
  audit(store);
});

test("SHU-146 ownership, rollback, and concurrent number claims", async () => {
  const { store, deps } = await setup();
  await refused(setOwnCivilId(input("unknown"), deps), "not_found");
  await refused(setOwnCivilId(input(), { ...deps, links: { resolveLink: async () => ({ kind: "conflict" }) } }), "not_found");
  await refused(setOwnCivilId(input(), { ...deps, store: { transaction: (keys, work) => store.transaction(keys,
    (tx) => work({ ...tx, audit: async () => { throw new Error(f.number); } })) } }), "civil_id_unavailable");
  assert.equal(store.rows.size, 0);
  assert.equal(store.audits.length, 0);
  const outcomes = await Promise.allSettled([setOwnCivilId(input(), deps), setOwnCivilId(input(f.Q), deps)]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(store.rows.size, 1);
  assert.equal(store.audits.length, 1);
  audit(store);
});
