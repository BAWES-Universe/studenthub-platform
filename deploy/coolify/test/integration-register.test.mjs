import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateRegister } from "../integration-register.mjs";

const registerUrl = new URL("../integration-register.json", import.meta.url);
const docsUrl = new URL("../../../docs/integrations.md", import.meta.url);
const register = JSON.parse(await readFile(registerUrl, "utf8"));
const expected = [
  ["INT-01", "rotate-revoke", "replace"], ["INT-02", "rotate-revoke", "replace"], ["INT-03", "operator-check", "pending"],
  ["INT-04", "operator-check", "keep"], ["INT-05", "operator-check", "pending"], ["INT-06", "operator-check", "drop"],
  ["INT-07", "rotate-revoke", "replace"], ["INT-08", "none", "drop"], ["INT-09", "operator-check", "drop"],
  ["INT-10", "operator-check", "drop"], ["INT-11", "rotate-revoke", "pending"], ["INT-12", "rotate-revoke", "keep"],
  ["INT-13", "operator-check", "replace"], ["INT-14", "rotate-revoke", "keep"], ["INT-15", "rotate-revoke", "pending"],
  ["INT-16", "operator-check", "keep"], ["INT-17", "db-state-unknown", "pending"], ["INT-18", "db-state-unknown", "pending"],
  ["INT-19", "db-state-unknown", "keep"], ["INT-20", "rotate-revoke", "keep"], ["INT-21", "rotate-revoke", "replace"],
  ["INT-22", "rotate-revoke", "drop"], ["INT-23", "rotate-revoke", "pending"], ["INT-24", "rotate-revoke", "drop"],
  ["INT-25", "operator-check", "drop"], ["INT-26", "none", "keep"], ["INT-27", "rotate-revoke", "replace"],
];

test("committed integration register validates", () => {
  assert.deepEqual(validateRegister(register), { ok: true, errors: [] });
});

test("every integration requires an owner and identifies its entry", () => {
  for (const entry of register.integrations) {
    const copy = structuredClone(register);
    delete copy.integrations.find(({ id }) => id === entry.id).owner;
    const result = validateRegister(copy);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes(entry.id) && error.includes("owner")));
  }
});

test("ids, rotation states, and dispositions match the inventory", () => {
  assert.deepEqual(register.integrations.map(({ id, rotation_state, disposition }) => [id, rotation_state, disposition]), expected);
});

test("register contains no value-like string", () => {
  assert.deepEqual(validateRegister(register).errors.filter((error) => error.includes("secret value or location")), []);
});

test("entries reject undeclared fields and wrongly typed fields", () => {
  const cases = [
    ["extra", { token: "https://example.com/secret" }, "INT-01 extra is not a register field"],
    ["credential_names", "SOME_SECRET", "INT-01 credential_names has the wrong type"],
    ["owner_cards", ["SHU-1", { card: "SHU-2" }], "INT-01 owner_cards has the wrong type"],
    ["notes", { text: "note" }, "INT-01 notes has the wrong type"],
  ];
  for (const [field, value, error] of cases) {
    const copy = structuredClone(register);
    copy.integrations[0][field] = value;
    const result = validateRegister(copy);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes(error), `${field}: ${result.errors.join("; ")}`);
  }
});

test("integration documentation lists every id", async () => {
  const docs = await readFile(docsUrl, "utf8");
  for (const [id] of expected) assert.match(docs, new RegExp(`\\| ${id} \\|`));
});
