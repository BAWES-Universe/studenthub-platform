import assert from "node:assert/strict";
import test from "node:test";

// Recruit R5 domain rules, loaded by URL so the mutation script can swap in a mutant.
const modulePath = process.env.REC5_EMPLOYER_MODULE ?? new URL("../src/employer-view.js", import.meta.url).href;
const m = await import(modulePath) as typeof import("../src/employer-view.js");

test("REC5_AGE whole years, counting the birthday itself; nonsense dates give no age", () => {
  assert.equal(m.ageOn("2000-06-15", "2026-06-14"), 25);
  assert.equal(m.ageOn("2000-06-15", "2026-06-15"), 26);
  assert.equal(m.ageOn("2000-06-15", "2026-05-20"), 25);
  assert.equal(m.ageOn("2000-06-15", "2026-07-01"), 26);
  for (const bad of [null, "2000/06/15", "2030-01-01", "1800-01-01"]) assert.equal(m.ageOn(bad, "2026-06-15"), null, String(bad));
});

test("REC5_SIGHT a live card or an invitation not withdrawn gives sight; withdrawn on both sides, or no link, gives none", () => {
  assert.equal(m.employerMaySee(null), false);
  assert.equal(m.employerMaySee({ stage: "suggested", invitation_status: null }), true);
  assert.equal(m.employerMaySee({ stage: null, invitation_status: "declined" }), true);
  assert.equal(m.employerMaySee({ stage: "withdrawn", invitation_status: "sent" }), true);
  assert.equal(m.employerMaySee({ stage: "withdrawn", invitation_status: null }), false);
  assert.equal(m.employerMaySee({ stage: null, invitation_status: "withdrawn" }), false);
  assert.equal(m.employerMaySee({ stage: "withdrawn", invitation_status: "withdrawn" }), false);
});

test("REC5_VIEW work-relevant fields with background in order; birth date shows only as age; withdrawn links are not shown", () => {
  const person = { principal_id: "p", name: "Noor", arabic_name: "نور", objective: "Sales", introduction: null, preferred_time: "Evenings", gender: "female", birth_date: "2000-06-15", driving_licence: true, nationality_name: "Kuwait", area_name: "Salmiya", job_search_status: "open_to_offers" };
  const records = [
    { kind: "skill" as const, fields: { name: "Retail" }, university: null, degree: null, major: null },
    { kind: "experience" as const, fields: { title: "Cashier", employer: "Co", startYear: 2020, endYear: 2021 }, university: null, degree: null, major: null },
    { kind: "experience" as const, fields: { title: "Lead", employer: "Co2", startYear: 2023 }, university: null, degree: null, major: null },
    { kind: "experience" as const, fields: { title: "", employer: "x", startYear: 2019 }, university: null, degree: null, major: null },
    { kind: "education" as const, fields: { educationType: "standard", currentlyStudying: true }, university: "KU", degree: "BSc", major: "Business" },
    { kind: "education" as const, fields: { educationType: "custom_university", institutionName: "Abroad U", customMajor: "Art", graduationYear: 2022, currentlyStudying: false }, university: null, degree: null, major: null },
    { kind: "skill" as const, fields: { name: "Arabic" }, university: null, degree: null, major: null },
  ];
  const v = m.employerPersonView(person, records, { stage: "contacted", invitation_status: "withdrawn" }, "2026-06-15");
  assert.equal(v.age, 26);
  assert.equal("birthDate" in v, false);
  assert.equal(v.lookingForWork, true);
  assert.deepEqual(v.experience.map((e) => e.title), ["Lead", "Cashier"]);
  assert.deepEqual(v.skills, ["Arabic", "Retail"]);
  assert.deepEqual(v.education, [{ institution: "KU", degree: "BSc", major: "Business", graduationYear: null, currentlyStudying: true }, { institution: "Abroad U", degree: null, major: "Art", graduationYear: 2022, currentlyStudying: false }]);
  assert.deepEqual([v.stage, v.invitation], ["contacted", null]);
  const quiet = m.employerPersonView({ ...person, job_search_status: "not_looking" }, [], { stage: "withdrawn", invitation_status: "seen" }, "2026-06-15");
  assert.deepEqual([quiet.stage, quiet.invitation, quiet.lookingForWork], [null, "seen", false]);
});
