import assert from "node:assert/strict";
import test from "node:test";

import { parseContactForm } from "../../../packages/access/src/company-contacts.js";
import { mapLegacyContacts } from "../src/m4-contacts.js";

// Synthetic contact rows only.
const link = (id: string, person: string, extra: Record<string, unknown> = {}) => ({
  company_contact_uuid: id, contact_uuid: person, company_id: 7, contact_position: " Accountant ", allow_access: 0,
  created_at: "2023-05-01 21:30:00", updated_at: "2023-05-02 09:00:00", ...extra,
});
const person = (id: string, extra: Record<string, unknown> = {}) => ({ contact_uuid: id, contact_name: ` Person ${id} `, contact_email: `${id}@Example.com`, deleted: 0, ...extra });
const email = (id: string, personId: string, address: unknown, at = "2023-01-01 10:00:00") => ({ email_uuid: id, contact_uuid: personId, email_address: address, email_created_datetime: at });
const phone = (id: string, personId: string, number: unknown, at = "2023-01-01 10:00:00") => ({ phone_uuid: id, contact_uuid: personId, phone_number: number, phone_created_datetime: at });

test("a link without access maps to a contact with the person's name, position and channels in legacy order", () => {
  const { contacts, issues } = mapLegacyContacts([link("l-1", "p-1")], [person("p-1")],
    [email("e-2", "p-1", "second@example.com", "2023-02-01 10:00:00"), email("e-1", "p-1", " First@Example.com "), email("e-3", "p-1", "p-1@example.com")],
    [phone("f-1", "p-1", "+965 5000-0001"), phone("f-2", "p-1", "(965) 2222 3333", "2023-03-01 00:00:00")]);
  assert.deepEqual(issues, []);
  assert.deepEqual({ ...contacts[0], digest: undefined }, {
    legacyId: "l-1", companyLegacyId: "7", name: "Person p-1", roleTitle: "Accountant",
    phones: ["+96550000001", "96522223333"], emails: ["p-1@example.com", "first@example.com", "second@example.com"],
    removed: false, createdAt: "2023-05-01T18:30:00.000Z", updatedAt: "2023-05-02T06:00:00.000Z", digest: undefined,
  });
});

test("an imported contact is one the contacts screen would save", () => {
  const [contact] = mapLegacyContacts([link("l-1", "p-1")], [person("p-1")], [], [phone("f-1", "p-1", "5000 0001")]).contacts;
  const form: Record<string, string> = { name: contact!.name, roleTitle: contact!.roleTitle ?? "" };
  contact!.phones.forEach((v, i) => { form[`phone${i}`] = v; });
  contact!.emails.forEach((v, i) => { form[`email${i}`] = v; });
  const parsed = parseContactForm(form);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.input.phones.map((p) => p.value), contact!.phones);
  assert.deepEqual(parsed.ok && parsed.input.emails.map((e) => e.value), contact!.emails);
});

test("a member with access is left for the grant import; one person on two companies gives two contacts", () => {
  const { contacts, issues } = mapLegacyContacts(
    [link("l-2", "p-1", { company_id: "9" }), link("l-1", "p-1"), link("l-3", "p-2", { allow_access: 1 }), link("l-4", "p-2", { allow_access: true })],
    [person("p-1"), person("p-2")], [], []);
  assert.deepEqual(contacts.map((c) => [c.legacyId, c.companyLegacyId]), [["l-1", "7"], ["l-2", "9"]]);
  assert.deepEqual(issues, [{ rule: "contact.access", legacyId: "l-3" }, { rule: "contact.access", legacyId: "l-4" }]);
});

test("a contact deleted in legacy imports as removed; the digest follows the mapped content", () => {
  const [kept] = mapLegacyContacts([link("l-1", "p-1")], [person("p-1")], [], []).contacts;
  const [removed] = mapLegacyContacts([link("l-1", "p-1")], [person("p-1", { deleted: 1 })], [], []).contacts;
  assert.equal(removed!.removed, true);
  assert.notEqual(removed!.digest, kept!.digest);
  const [same] = mapLegacyContacts([link("l-1", "p-1", { created_by: "x" })], [person("p-1", { contact_password_hash: "h", contact_status: 0 })], [], []).contacts;
  assert.equal(same!.digest, kept!.digest);
});

test("a link that cannot be kept is left out and reported", () => {
  const { contacts, issues } = mapLegacyContacts([
    link("l-1", "p-1"), link("l-1", "p-1"), link("", "p-1"), link("l-2", "p-1", { company_id: null }), link("l-3", "p-404"),
    link("l-4", "p-blank"), link("l-5", "p-long"), link("l-6", "p-ctl"),
  ], [person("p-1"), person("p-blank", { contact_name: "  " }), person("p-long", { contact_name: "x".repeat(121) }), person("p-ctl", { contact_name: "a\u0007b" })], [], []);
  assert.deepEqual(contacts.map((c) => c.legacyId), ["l-1"]);
  assert.deepEqual(issues, [
    { rule: "contact.duplicateId", legacyId: "l-1" },
    { rule: "contact.badId", legacyId: "?" },
    { rule: "contact.noCompany", legacyId: "l-2", field: "company_id" },
    { rule: "contact.noPerson", legacyId: "l-3", field: "contact_uuid" },
    { rule: "contact.badName", legacyId: "l-4", field: "contact_name" },
    { rule: "contact.badName", legacyId: "l-5", field: "contact_name" },
    { rule: "contact.badName", legacyId: "l-6", field: "contact_name" },
  ]);
});

test("an unusable optional value is dropped and reported; past five channels the first five are kept", () => {
  const many = Array.from({ length: 7 }, (_, i) => phone(`f-${i}`, "p-1", `5000000${i}`, `2023-01-0${i + 1} 10:00:00`));
  const { contacts, issues } = mapLegacyContacts([link("l-1", "p-1", { contact_position: "y".repeat(121) })], [person("p-1", { contact_email: "not an email" })],
    [email("e-1", "p-1", "ok@example.com"), email("e-2", "p-1", 5)], [...many, phone("f-x", "p-1", "12")]);
  assert.equal(contacts[0]!.roleTitle, null);
  assert.deepEqual(contacts[0]!.emails, ["ok@example.com"]);
  assert.deepEqual(contacts[0]!.phones, ["50000000", "50000001", "50000002", "50000003", "50000004"]);
  assert.deepEqual(issues, [
    { rule: "contact.badRoleTitle", legacyId: "l-1", field: "contact_position" },
    { rule: "contact.badEmail", legacyId: "l-1" },
    { rule: "contact.badPhone", legacyId: "l-1" },
    { rule: "contact.tooManyPhones", legacyId: "l-1" },
  ]);
});

test("issues carry no legacy text", () => {
  const secret = "Private Person Fatima";
  const { issues } = mapLegacyContacts([link("l-1", "p-1", { contact_position: secret.repeat(9) }), link("l-2", "p-2")],
    [person("p-1", { contact_email: `${secret}@` }), person("p-2", { contact_name: secret.repeat(9) })], [], [phone("f", "p-1", secret)]);
  assert.ok(issues.length >= 3);
  assert.ok(!JSON.stringify(issues).includes("Private"));
});

test("allow_access is read as legacy stores it: only 0 makes a contact, only 1 a member, anything else is quarantined", () => {
  const values: [string, unknown][] = [["a0", 0], ["a1", "0"], ["a2", false], ["b0", 1], ["b1", "1"], ["b2", true],
    ["c0", null], ["c1", undefined], ["c2", ""], ["c3", 2], ["c4", "yes"], ["c5", "01"], ["c6", " 0"]];
  const links = values.map(([id, value]) => { const row: Record<string, unknown> = link(id, "p-1", { allow_access: value }); if (value === undefined) delete row.allow_access; return row; });
  const { contacts, issues, dispositions } = mapLegacyContacts(links, [person("p-1")], [email("e-1", "p-1", "x@example.com")], [phone("f-1", "p-1", "50000001")]);
  assert.deepEqual(contacts.map((c) => c.legacyId), ["a0", "a1", "a2"]);
  assert.deepEqual(dispositions, { contact: ["a0", "a1", "a2"], access: ["b0", "b1", "b2"], quarantined: ["c0", "c1", "c2", "c3", "c4", "c5", "c6"], refused: [] });
  // A quarantined link copies nothing: no row, no channels, only its id and code.
  assert.deepEqual(issues.filter((i) => i.rule === "contact.badAccess").map((i) => [i.legacyId, i.field]),
    ["c0", "c1", "c2", "c3", "c4", "c5", "c6"].map((id) => [id, "allow_access"]));
  assert.ok(!JSON.stringify({ issues, dispositions }).includes("example.com"));
});

test("every link with a usable id lands in exactly one disposition, for reconciliation by link id", () => {
  const links = [link("l-1", "p-1"), link("l-2", "p-1", { allow_access: 1 }), link("l-3", "p-1", { allow_access: null }),
    link("l-4", "p-404"), link("l-5", "p-1", { company_id: 0 }), link("l-6", "p-blank"), link("l-1", "p-1"), link("", "p-1")];
  const { dispositions } = mapLegacyContacts(links, [person("p-1"), person("p-blank", { contact_name: "" })], [], []);
  const all = [...dispositions.contact, ...dispositions.access, ...dispositions.quarantined, ...dispositions.refused];
  assert.deepEqual([...all].sort(), ["l-1", "l-2", "l-3", "l-4", "l-5", "l-6"]);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(dispositions.refused, ["l-4", "l-5", "l-6"]);
});
