import assert from "node:assert/strict";
import test from "node:test";

import { validateCivilId, validatePersonSelfEditValue } from "@studenthub/profile";
import { M1_CONTACT_SOURCES, mapLegacyPersonContacts } from "../src/m1-contact.js";
import { mapLegacyCandidates } from "../src/m1-people.js";

// Synthetic rows only. Numbers are made up and shaped like legacy's columns.
const TODAY = "2026-11-25";
const candidate = (id: number | string, extra: Record<string, unknown> = {}) => ({
  candidate_id: id, deleted: 0, candidate_name: "Test Person", candidate_phone: null, profile_url: null,
  candidate_civil_id: null, candidate_civil_need_verification: null, ...extra,
});
const map = (rows: readonly Record<string, unknown>[]) => {
  const { people } = mapLegacyCandidates({ candidate: rows, country: [], university: [], area: [] }, TODAY);
  return mapLegacyPersonContacts(rows, people);
};

test("phone, handle and civil ID map to the values the platform's own rules store", () => {
  const { contacts, issues } = map([
    candidate(1, { candidate_phone: "5000 1234", profile_url: "Noor.Test", candidate_civil_id: "2990 1011 2345", candidate_civil_need_verification: 1 }),
    candidate(2, { candidate_phone: "00965 6000-1234", profile_url: " noor_2 ", candidate_civil_id: "٩٩٠١٢٣٤٥٦", candidate_civil_need_verification: "0" }),
    candidate(3, { candidate_phone: 96570001234 }),
    candidate(4, { candidate_phone: "+44 20 7183 8750" }),
  ]);
  assert.deepEqual(issues, []);
  assert.deepEqual(contacts, [
    { legacyId: "1", phone: "+96550001234", handle: "noor.test", civilId: { country: "KW", number: "299010112345" }, civilIdNeedsReview: true },
    { legacyId: "2", phone: "+96560001234", handle: "noor_2", civilId: { country: "BH", number: "990123456" }, civilIdNeedsReview: false },
    { legacyId: "3", phone: "+96570001234", handle: null, civilId: null, civilIdNeedsReview: null },
    { legacyId: "4", phone: "+442071838750", handle: null, civilId: null, civilIdNeedsReview: null },
  ]);
  // Every stored value is one the platform's write would accept as it is.
  for (const c of contacts) {
    if (c.phone) assert.deepEqual(validatePersonSelfEditValue("phone", c.phone, TODAY), { ok: true, value: c.phone });
    if (c.handle) assert.deepEqual(validatePersonSelfEditValue("handle", c.handle, TODAY), { ok: true, value: c.handle });
    if (c.civilId) assert.deepEqual(validateCivilId(c.civilId), { ok: true, value: c.civilId });
  }
});

test("a value the platform refuses is not recorded, with a row naming the column and never the value", () => {
  const secrets = ["12345", "https://example.invalid/u/noor", "no", "1noor", "12345678901", "ABC123456789", "phone!"];
  const { contacts, issues } = map([
    candidate(5, { candidate_phone: "12345", profile_url: "https://example.invalid/u/noor", candidate_civil_id: "12345678901" }),
    candidate(6, { candidate_phone: "phone!", profile_url: "no", candidate_civil_id: "ABC123456789", candidate_civil_need_verification: 1 }),
    candidate(7, { profile_url: "1noor", candidate_phone: "+965 5000 1234" }),
    candidate(8, { candidate_civil_id: { number: "299010112345" }, candidate_phone: true, profile_url: 42 }),
  ]);
  assert.deepEqual(contacts, [{ legacyId: "7", phone: "+96550001234", handle: null, civilId: null, civilIdNeedsReview: null }]);
  assert.deepEqual(issues, [
    { rule: "contact.civilIdRule", legacyId: "5", field: "candidate_civil_id" },
    { rule: "contact.handleRule", legacyId: "5", field: "profile_url" },
    { rule: "contact.phoneRule", legacyId: "5", field: "candidate_phone" },
    { rule: "contact.civilIdRule", legacyId: "6", field: "candidate_civil_id" },
    { rule: "contact.handleRule", legacyId: "6", field: "profile_url" },
    { rule: "contact.phoneRule", legacyId: "6", field: "candidate_phone" },
    { rule: "contact.handleRule", legacyId: "7", field: "profile_url" },
    { rule: "contact.civilIdRule", legacyId: "8", field: "candidate_civil_id" },
    { rule: "contact.handleRule", legacyId: "8", field: "profile_url" },
    { rule: "contact.phoneRule", legacyId: "8", field: "candidate_phone" },
  ]);
  const text = JSON.stringify(issues);
  for (const s of secrets) assert.ok(!text.includes(s), s);
});

test("a phone, handle or civil ID held by two imported people is recorded for neither, each row naming the other", () => {
  const { contacts, issues } = map([
    candidate(20, { candidate_phone: "50001234", profile_url: "Shared.Handle", candidate_civil_id: "299010112345" }),
    candidate(11, { candidate_phone: "+965 5000 1234", profile_url: "shared.handle", candidate_civil_id: "2990-1011-2345" }),
    candidate(12, { candidate_phone: "96550001234", profile_url: "own.handle", candidate_civil_id: "990123456" }),
    candidate(13, { candidate_civil_id: "990123457" }),
  ]);
  assert.deepEqual(contacts, [
    { legacyId: "12", phone: null, handle: "own.handle", civilId: { country: "BH", number: "990123456" }, civilIdNeedsReview: null },
    { legacyId: "13", phone: null, handle: null, civilId: { country: "BH", number: "990123457" }, civilIdNeedsReview: null },
  ]);
  assert.deepEqual(issues, [
    { rule: "contact.civilIdDuplicate", legacyId: "11", field: "candidate_civil_id", target: "20" },
    { rule: "contact.handleDuplicate", legacyId: "11", field: "profile_url", target: "20" },
    { rule: "contact.phoneDuplicate", legacyId: "11", field: "candidate_phone", target: "12" },
    { rule: "contact.phoneDuplicate", legacyId: "12", field: "candidate_phone", target: "11" },
    { rule: "contact.civilIdDuplicate", legacyId: "20", field: "candidate_civil_id", target: "11" },
    { rule: "contact.handleDuplicate", legacyId: "20", field: "profile_url", target: "11" },
    { rule: "contact.phoneDuplicate", legacyId: "20", field: "candidate_phone", target: "11" },
  ]);
});

test("only candidates M-1 imports are mapped: an archived or duplicated candidate holds nothing and blocks nobody", () => {
  const { contacts, issues } = map([
    candidate(30, { candidate_phone: "50001234", candidate_civil_id: "299010112345" }),
    candidate(31, { deleted: 1, candidate_phone: "50001234", candidate_civil_id: "299010112345" }),
    candidate(32, { candidate_phone: "50009999" }), candidate(32, { candidate_phone: "50008888" }),
    candidate("bad", { candidate_phone: "50007777" }),
  ]);
  assert.deepEqual(issues, []);
  assert.deepEqual(contacts.map((c) => [c.legacyId, c.phone]), [["30", "+96550001234"]]);
});

test("the review flag is recorded only with a civil ID, and an unknown flag value is a row, not a guess", () => {
  const { contacts, issues } = map([
    candidate(40, { candidate_civil_id: "299010112345", candidate_civil_need_verification: "yes" }),
    candidate(41, { candidate_civil_need_verification: 1, profile_url: "flag.only" }),
    candidate(42, { candidate_civil_id: "299010112346", candidate_civil_need_verification: false }),
  ]);
  assert.deepEqual(issues, [{ rule: "contact.badValue", legacyId: "40", field: "candidate_civil_need_verification" }]);
  assert.deepEqual(contacts.map((c) => [c.legacyId, c.civilIdNeedsReview]), [["40", null], ["41", null], ["42", false]]);
});

test("output is ordered by legacy id and the same input gives the same output", () => {
  const rows = [candidate(100, { profile_url: "c.three" }), candidate(9, { profile_url: "a.one" }), candidate(10, { profile_url: "b.two" })];
  const first = map(rows);
  assert.deepEqual(first.contacts.map((c) => c.legacyId), ["9", "10", "100"]);
  assert.deepEqual(map([...rows].reverse()), first);
  assert.ok(Object.isFrozen(first.contacts) && Object.isFrozen(first.contacts[0]));
});

test("the mapper reads only the listed columns, and the list holds no email, password, token or document", () => {
  assert.deepEqual([...M1_CONTACT_SOURCES.candidate].sort(),
    ["candidate_civil_id", "candidate_civil_need_verification", "candidate_id", "candidate_phone", "profile_url"]);
  for (const column of M1_CONTACT_SOURCES.candidate) assert.doesNotMatch(column, /email|password|hash|token|photo|resume|iban|latitude|longitude/);
  const read = new Set<string>();
  const proxy = (row: Record<string, unknown>) => new Proxy(row, { get: (target, key) => { if (typeof key === "string") read.add(key); return target[key as string]; } });
  const rows = [candidate(50, { candidate_phone: "50001234", profile_url: "proxy.me", candidate_civil_id: "299010112345", candidate_civil_need_verification: 1, candidate_email: "x@example.invalid" })];
  const { people } = mapLegacyCandidates({ candidate: rows, country: [], university: [], area: [] }, TODAY);
  mapLegacyPersonContacts(rows.map(proxy), people);
  assert.deepEqual([...read].filter((k) => !(M1_CONTACT_SOURCES.candidate as readonly string[]).includes(k)), []);
});
