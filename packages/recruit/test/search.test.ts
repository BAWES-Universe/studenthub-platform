import assert from "node:assert/strict";
import test from "node:test";

// Recruit R3 domain rules, loaded by URL so the mutation script can swap in a mutant.
const modulePath = process.env.REC3_SEARCH_MODULE ?? new URL("../src/search.js", import.meta.url).href;
const m = await import(modulePath) as typeof import("../src/search.js");
const OPS = ["root"];
const grant = (org_id: string, role: string, scope = "subtree") => ({ org_id, role, scope });
const A = "123e4567-e89b-42d3-a456-426614174000", B = "223e4567-e89b-42d3-a456-426614174000";
const empty = { q: "", area: [], nationality: [], university: [], availability: [], drivingLicence: [], gender: [], includeIncomplete: false, page: 1 };

test("REC3_DECISION operator staff, admins and recruiters search people; companies and self grants do not", () => {
  for (const role of ["staff", "admin", "recruiter"]) {
    assert.equal(m.peopleSearchDecision([grant("root", role)], OPS), true, role);
    assert.equal(m.peopleSearchDecision([grant("co", role)], OPS), false, `company ${role}`);
    assert.equal(m.peopleSearchDecision([grant("root", role, "self")], OPS), false, `self ${role}`);
  }
  assert.equal(m.peopleSearchDecision([grant("root", "org-owner")], OPS), false);
});

test("REC3_PARSE facets repeat, are deduplicated and checked; text, page and flags are bounded; unknown keys are refused", () => {
  assert.deepEqual(m.parsePeopleSearch({}), empty);
  assert.deepEqual(m.parsePeopleSearch({ q: "  نور ", area: [A.toUpperCase(), A, ""], availability: ["active"], drivingLicence: "yes", gender: ["female", "male"], includeIncomplete: "1", page: "3" }),
    { ...empty, q: "نور", area: [A], availability: ["active"], drivingLicence: ["yes"], gender: ["female", "male"], includeIncomplete: true, page: 3 });
  assert.deepEqual(m.parsePeopleSearch({ university: [A, B], nationality: B, includeIncomplete: "0", page: "" }), { ...empty, university: [A, B], nationality: [B] });
  assert.equal(m.parsePeopleSearch({ area: Array.from({ length: 20 }, (_, i) => `${String(i).padStart(8, "0")}-e89b-42d3-a456-426614174000`) })?.area.length, 20);
  for (const bad of [{ area: "nope" }, { availability: "not_looking" }, { gender: "any" }, { drivingLicence: "maybe" }, { includeIncomplete: "yes" }, { page: "0" }, { page: "401" }, { page: "1.5" },
    { q: "x".repeat(201) }, { q: "a\u0000" }, { q: ["a", "b"] }, { page: ["1", "2"] }, { sort: "name" },
    { area: Array.from({ length: 21 }, (_, i) => `${String(i).padStart(8, "0")}-e89b-42d3-a456-426614174000`) }]) {
    assert.equal(m.parsePeopleSearch(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(m.searchTokens("Noor  AL-Sabah! نور 2"), ["noor", "al", "sabah", "نور", "2"]);
  assert.equal(m.searchTokens("a b c d e f g h i j").length, 8);
});

test("REC3_FACETS counts sort most common first; selected values stay listed even at zero; fixed facets get labels", () => {
  const view = m.facetView([
    { facet: "area", value: A, label: "Hawalli", count: 2 }, { facet: "area", value: "x", label: "Salmiya", count: 5 },
    { facet: "availability", value: "open_to_offers", label: null, count: 1 }, { facet: "gender", value: "female", label: null, count: 3 },
    { facet: "drivingLicence", value: "yes", label: null, count: 4 },
  ], { ...empty, area: [A], nationality: [B], gender: ["male"] });
  assert.deepEqual(view.area.map((v) => [v.label, v.count, v.selected]), [["Salmiya", 5, false], ["Hawalli", 2, true]]);
  assert.deepEqual(view.nationality, [{ value: B, label: "Unknown", count: 0, selected: true }]);
  assert.deepEqual(view.availability, [{ value: "open_to_offers", label: "Open to offers", count: 1, selected: false }]);
  assert.deepEqual(view.gender.map((v) => [v.label, v.count, v.selected]), [["Female", 3, false], ["Male", 0, true]]);
  assert.equal(view.drivingLicence[0]!.label, "Has a driving licence");
  assert.deepEqual(view.university, []);
});

test("REC3_VIEW a result shows its facts with universities in order, and a search reproduces as a query string", () => {
  const row = { principal_id: "p", name: "Noor", arabic_name: null, objective: "Sales", availability: "active" as const, gender: "female" as const, driving_licence: true, area_name: "Salmiya", nationality_name: "Kuwait", universities: ["Zeta", "Alpha"], complete: true };
  assert.deepEqual(m.searchPersonView(row), { personId: "p", name: "Noor", arabicName: null, objective: "Sales", availability: "active", area: "Salmiya", nationality: "Kuwait", universities: ["Alpha", "Zeta"], gender: "female", drivingLicence: true, complete: true });
  const query = m.parsePeopleSearch({ q: "noor", area: [A, B], gender: "female", includeIncomplete: "1", page: "2" })!;
  assert.equal(m.searchQueryString(query), `q=noor&area=${A}&area=${B}&gender=female&includeIncomplete=1&page=2`);
  assert.equal(m.searchQueryString(query, 1), `q=noor&area=${A}&area=${B}&gender=female&includeIncomplete=1`);
  assert.deepEqual(m.parsePeopleSearch(Object.fromEntries([...new URLSearchParams(m.searchQueryString(query))].reduce((acc, [k, v]) => acc.set(k, [...(acc.get(k) ?? []), v]), new Map<string, string[]>()))), query);
  assert.equal(m.searchQueryString(empty), "");
});
