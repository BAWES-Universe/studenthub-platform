import assert from "node:assert/strict";
import test from "node:test";

// Recruit R7 domain rules, loaded by URL so the mutation script can swap in a mutant.
const modulePath = process.env.REC7_JOBS_MODULE ?? new URL("../src/jobs.js", import.meta.url).href;
const m = await import(modulePath) as typeof import("../src/jobs.js");
type A = import("../src/jobs.js").ApplicationStatus;
const REQ = "223e4567-e89b-42d3-a456-426614174000", AREA = "523e4567-e89b-42d3-a456-426614174000";

test("REC7_RULES only operator staff manage jobs; only an active job takes applications; a rejection is final", () => {
  const ops = ["root"];
  assert.equal(m.jobStaffDecision([{ org_id: "root", role: "staff", scope: "subtree" }], ops), true);
  assert.equal(m.jobStaffDecision([{ org_id: "root", role: "admin", scope: "subtree" }], ops), true);
  assert.equal(m.jobStaffDecision([{ org_id: "root", role: "recruiter", scope: "subtree" }], ops), false, "legacy jobs were a staff tool");
  assert.equal(m.jobStaffDecision([{ org_id: "root", role: "staff", scope: "self" }], ops), false);
  assert.equal(m.jobStaffDecision([{ org_id: "acme", role: "staff", scope: "subtree" }], ops), false);
  assert.equal(m.jobCandidateDecision([{ org_id: "acme", role: "candidate", scope: "self" }]), true, "the candidate surface is candidate:self");
  assert.equal(m.jobCandidateDecision([{ org_id: "acme", role: "org-owner", scope: "self" }, { org_id: "root", role: "staff", scope: "subtree" }]), false, "employer and staff accounts are not candidates");
  assert.equal(m.jobCandidateDecision([]), false);
  assert.deepEqual(m.JOB_STATUSES.filter(m.jobAcceptsApplications), ["active"]);
  const all: A[] = ["interested", "shortlisted", "rejected"];
  assert.deepEqual(all.flatMap((a) => all.filter((b) => m.applicationTransitionAllowed(a, b)).map((b) => `${a}>${b}`)), ["interested>shortlisted", "interested>rejected", "shortlisted>rejected"]);
  assert.equal(m.applicationOutbox("interested", "a1", "p1"), null, "applying tells no one");
  assert.deepEqual(m.applicationOutbox("shortlisted", "a1", "p1"), { kind: "application.shortlisted", recipient: "p1", dedupeKey: "application.shortlisted:a1" });
  assert.deepEqual(m.applicationOutbox("rejected", "a1", "p1"), { kind: "application.rejected", recipient: "p1", dedupeKey: "application.rejected:a1" });
});

test("REC7_PARSE the legacy job form: bounded text, numbers from strings, skills split and de-duplicated, sane ranges", () => {
  const job = m.parseJob({ requestId: REQ.toUpperCase(), areaId: AREA, position: " Cashier ", positionAr: "كاشير", description: "Line one\nLine two", hoursPerDay: "6", daysPerWeek: "5", compensationType: "hourly", compensationAmount: "3 KWD",
    minAge: "18", maxAge: "30", gender: "female", availableFrom: "2026-12-01", availableTo: "2026-12-31", status: "active", skills: "Arabic, English\nArabic, " });
  assert.deepEqual(job, { requestId: REQ, areaId: AREA, position: "Cashier", positionAr: "كاشير", description: "Line one\nLine two", descriptionAr: null, hoursPerDay: 6, daysPerWeek: 5, compensationType: "hourly",
    compensationAmount: "3 KWD", compensationDescription: null, compensationDescriptionAr: null, minAge: 18, maxAge: 30, gender: "female", availableFrom: "2026-12-01", availableTo: "2026-12-31", status: "active", skills: ["Arabic", "English"] });
  assert.deepEqual([m.parseJob({ requestId: REQ, position: "Sales" })?.status, m.parseJob({ requestId: REQ, position: "Sales" })?.gender], ["draft", "any"]);
  for (const bad of [
    { requestId: REQ }, { requestId: "nope", position: "x" }, { requestId: REQ, position: "x", status: "open" }, { requestId: REQ, position: "x", gender: "4" },
    { requestId: REQ, position: "x", minAge: "30", maxAge: "18" }, { requestId: REQ, position: "x", hoursPerDay: "25" }, { requestId: REQ, position: "x", daysPerWeek: 8 },
    { requestId: REQ, position: "x", availableFrom: "2026-12-31", availableTo: "2026-12-01" }, { requestId: REQ, position: "x", availableFrom: "2026-02-30" },
    { requestId: REQ, position: "x", areaId: "Hawalli" }, { requestId: REQ, position: "line\nbreak" }, { requestId: REQ, position: "x", skills: Array.from({ length: 31 }, (_, i) => `s${i}`) },
    { requestId: REQ, position: "x", extra: 1 },
  ]) assert.equal(m.parseJob(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(m.parseApplication({ note: "  I can start Monday " }), { note: "I can start Monday" });
  assert.deepEqual(m.parseApplication({}), { note: null });
  assert.equal(m.parseApplication({ note: "x".repeat(2001) }), undefined);
  assert.equal(m.parseApplication({ note: "x", seenAt: "now" }), undefined);
  assert.deepEqual(m.parseJobQuery({ q: " cash ", applied: "1", page: "2" }), { q: "cash", applied: true, page: 2 });
  for (const bad of [{ q: ["a", "b"] }, { applied: "yes" }, { page: "0" }, { page: "1000" }, { sort: "new" }]) assert.equal(m.parseJobQuery(bad), undefined, JSON.stringify(bad));
});

test("REC7_VIEW criteria are shown, never applied; only an active job without an application can be applied to", () => {
  const row = { id: "j1", request_id: REQ, org_name: "Sultan Co", store_name: "Avenues", area_name: "Hawalli", position: "Cashier", position_ar: null, description: null, description_ar: null, hours_per_day: 6, days_per_week: 5,
    compensation_type: "hourly", compensation_amount: "3 KWD", compensation_description: null, compensation_description_ar: null, min_age: 18, max_age: 30, gender: "female" as const,
    available_from: null, available_to: null, status: "active" as const, skills: ["Arabic"], created_at: "2026-11-17T10:00:00Z", application_status: null };
  const v = m.jobView(row);
  assert.deepEqual([v.canApply, v.criteria, v.application, v.postedAt], [true, { minAge: 18, maxAge: 30, gender: "female" }, null, "2026-11-17T10:00:00.000Z"]);
  assert.equal(m.jobView({ ...row, application_status: "interested" }).canApply, false);
  assert.equal(m.jobView({ ...row, status: "closed" }).canApply, false);
  assert.equal(m.jobView({ ...row, status: "draft" }).canApply, false);
});
