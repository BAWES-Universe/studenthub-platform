import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTACT_FORM_KEYS,
  decideContactWrite,
  mayReadContacts,
  mayWriteContacts,
  normalizeContactPhone,
  parseContactForm,
  type HeldGrant,
} from "../src/index.js";

const ACME = "acme";
const grant = (role: string, orgId = ACME, scope: "self" | "subtree" = "self"): HeldGrant => ({ orgId, role, scope });

test("A3_CONTACT a contact is a name, an optional title and up to 5 normalized phones and emails", () => {
  assert.equal(normalizeContactPhone(" +965 (2222) 33-44 "), "+965222233" + "44");
  assert.equal(normalizeContactPhone("12345"), undefined);
  assert.equal(normalizeContactPhone("+1234567890123456789012"), undefined);
  assert.equal(normalizeContactPhone("12a4567"), undefined);
  const parsed = parseContactForm({ name: "  Layla  ", roleTitle: "", phone0: "+965 5555 1234", phoneLabel0: "Mobile", phone2: "22223333", email0: " Layla@Acme.example ", emailLabel1: "" });
  assert.deepEqual(parsed, { ok: true, input: { name: "Layla", roleTitle: null, phones: [{ value: "+96555551234", label: "Mobile" }, { value: "22223333", label: null }], emails: [{ value: "layla@acme.example", label: null }] } });
  assert.deepEqual(parseContactForm({ name: " " }), { ok: false, error: "name" });
  assert.deepEqual(parseContactForm({ name: "x".repeat(121) }), { ok: false, error: "name" });
  assert.deepEqual(parseContactForm({ name: "Ok", roleTitle: "t\u0007" }), { ok: false, error: "role_title" });
  assert.deepEqual(parseContactForm({ name: "Ok", phone0: "12" }), { ok: false, error: "phone" });
  assert.deepEqual(parseContactForm({ name: "Ok", email0: "no-at" }), { ok: false, error: "email" });
  assert.deepEqual(parseContactForm({ name: "Ok", phoneLabel0: "Mobile" }), { ok: false, error: "phone" }, "a label needs a value");
  assert.deepEqual(parseContactForm({ name: "Ok", phone0: "22223333", phoneLabel0: "x".repeat(41) }), { ok: false, error: "label" });
  assert.equal(CONTACT_FORM_KEYS.has("phone4"), true);
  assert.equal(CONTACT_FORM_KEYS.has("phone5"), false, "a sixth phone has no field");
  // Who writes: owners, and staff or admin covering the company; never a recruiter or finance member.
  assert.equal(mayWriteContacts([grant("org-owner")], ACME, []), true);
  assert.equal(mayWriteContacts([grant("staff", "root", "subtree")], ACME, ["root"]), true);
  assert.equal(mayWriteContacts([grant("recruiter")], ACME, []), false);
  assert.equal(mayWriteContacts([grant("finance")], ACME, []), false);
  assert.equal(mayWriteContacts([grant("org-owner", "group")], ACME, ["group"]), false, "a self grant on a parent does not reach the child");
  const snapshot = { callerGrants: [grant("recruiter")], orgLive: true, orgAncestors: [], liveContacts: 0 };
  assert.deepEqual(decideContactWrite(ACME, "create", snapshot), { kind: "refused", reason: "not_allowed" });
  assert.deepEqual(decideContactWrite(ACME, "create", { ...snapshot, callerGrants: [grant("org-owner")] }), { kind: "ok" });
  assert.deepEqual(decideContactWrite(ACME, "create", { ...snapshot, callerGrants: [grant("org-owner")], liveContacts: 200 }), { kind: "refused", reason: "too_many_contacts" });
  assert.deepEqual(decideContactWrite(ACME, "remove", { ...snapshot, callerGrants: [grant("org-owner")], orgLive: false }), { kind: "refused", reason: "unknown_organization" });
});

test("A3_READ_SITES owners, recruiters, finance members, staff and admin read; anyone else does not", () => {
  for (const role of ["org-owner", "recruiter", "finance"]) assert.equal(mayReadContacts([grant(role)], ACME, []), true, role);
  assert.equal(mayReadContacts([grant("admin", "root", "subtree")], ACME, ["root"]), true);
  assert.equal(mayReadContacts([grant("candidate")], ACME, []), false);
  assert.equal(mayReadContacts([grant("recruiter", "other")], ACME, []), false);
  assert.equal(mayReadContacts([], ACME, []), false);
});
