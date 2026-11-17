import assert from "node:assert/strict";
import test from "node:test";

// Recruit R9 domain rules, loaded by URL so the mutation script can swap in a mutant.
const modulePath = process.env.REC9_FULLTIMERS_MODULE ?? new URL("../src/fulltimers.js", import.meta.url).href;
const m = await import(modulePath) as typeof import("../src/fulltimers.js");
const AREA = "523e4567-e89b-42d3-a456-426614174000", TODAY = "2026-11-17";

test("REC9_RULES operator staff, admins and recruiters keep full-timers; duplicates match on folded names and compact phones", () => {
  const ops = ["root"];
  for (const role of ["staff", "admin", "recruiter"]) assert.equal(m.fulltimerStaffDecision([{ org_id: "root", role, scope: "subtree" }], ops), true, role);
  assert.equal(m.fulltimerStaffDecision([{ org_id: "root", role: "staff", scope: "self" }], ops), false);
  assert.equal(m.fulltimerStaffDecision([{ org_id: "acme", role: "org-owner", scope: "subtree" }], ops), false, "a company never reads salaries or contacts");
  assert.equal(m.fulltimerStaffDecision([{ org_id: "acme", role: "staff", scope: "subtree" }], ops), false, "nor do a company's own staff");
  assert.equal(m.fulltimerNameKey("  Fahad   AL-Ali "), "fahad al-ali");
  assert.equal(m.fulltimerNameKey("ＦＡＨＡＤ"), "fahad", "full-width letters fold");
  assert.equal(m.normalizePhone("+965 9999-1234"), "+96599991234");
  assert.equal(m.normalizePhone("(965) 9999 1234"), "96599991234");
  assert.equal(m.normalizePhone("call me"), undefined);
  assert.equal(m.normalizePhone("12345"), undefined);
});

test("REC9_PARSE the legacy form: lists split and de-duplicated, phone compacted, coordinates paired, sane dates, nothing extra", () => {
  const ok = m.parseFulltimer({ name: " Fahad ", phone: "+965 9999 1234", email: "f@example.com", areaId: AREA.toUpperCase(), latitude: "29.3759", longitude: "47.9774", gender: "male", birthDate: "1995-04-01",
    employed: "false", drivingLicence: "true", expectedSalary: "600", currencyCode: "kwd", tags: "sales, retail\nsales", skills: ["Arabic", " English "], experience: "Cashier at X, 2 years\nSupervisor", cvReference: "cv/fahad.pdf" }, TODAY);
  assert.deepEqual(ok, { name: "Fahad", phone: "+96599991234", email: "f@example.com", nationalityId: null, countryId: null, areaId: AREA, universityId: null, latitude: 29.3759, longitude: 47.9774, gender: "male", birthDate: "1995-04-01",
    employed: false, drivingLicence: true, currentSalary: null, expectedSalary: "600", currencyCode: "KWD", tags: ["sales", "retail"], skills: ["Arabic", "English"], experience: ["Cashier at X", "2 years", "Supervisor"], cvReference: "cv/fahad.pdf" });
  assert.equal(m.parseFulltimer({ name: "A" }, TODAY)?.currencyCode, "KWD");
  for (const bad of [{}, { name: "A", phone: "nope" }, { name: "A", email: "no-at" }, { name: "A", latitude: "29" }, { name: "A", latitude: "91", longitude: "0" }, { name: "A", birthDate: "2026-11-18" },
    { name: "A", birthDate: "2001-02-30" }, { name: "A", gender: "4" }, { name: "A", employed: "maybe" }, { name: "A", areaId: "Hawalli" }, { name: "A", currencyCode: "KW" }, { name: "A", tags: Array.from({ length: 31 }, (_, i) => `t${i}`) },
    { name: "line\nbreak" }, { name: "A", salary: "1" }])
    assert.equal(m.parseFulltimer(bad, TODAY), undefined, JSON.stringify(bad));
  assert.deepEqual(m.parseFulltimerQuery({ q: " fahad ", currency: "usd", tag: "sales", archived: "1", page: "3", request: "x" }), { q: "fahad", currency: "USD", tag: "sales", archived: true, page: 3 });
  for (const bad of [{ q: ["a", "b"] }, { archived: "yes" }, { currency: "dollars" }, { page: "0" }, { sort: "name" }]) assert.equal(m.parseFulltimerQuery(bad), undefined, JSON.stringify(bad));
});
