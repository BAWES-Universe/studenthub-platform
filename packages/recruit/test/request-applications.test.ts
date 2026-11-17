import assert from "node:assert/strict";
import test from "node:test";

// Recruit R7b domain rules, loaded by URL so the mutation script can swap in a mutant.
const modulePath = process.env.REC7B_APPLICATIONS_MODULE ?? new URL("../src/request-applications.js", import.meta.url).href;
const m = await import(modulePath) as typeof import("../src/request-applications.js");
const REQ = "223e4567-e89b-42d3-a456-426614174000", APP = "a23e4567-e89b-42d3-a456-426614174000";

test("REC7B_RULES open and filling requests take applications; an application is decided once; the recruiter hears of it and the person of the decision", () => {
  assert.deepEqual(["draft", "open", "filling", "filled", "closed"].map((s) => m.requestTakesApplications(s as never)), [false, true, true, false, false]);
  assert.equal(m.requestApplicationTransitionAllowed("applied", "accepted"), true);
  assert.equal(m.requestApplicationTransitionAllowed("applied", "rejected"), true);
  assert.equal(m.requestApplicationTransitionAllowed("accepted", "rejected"), false, "an accepted applicant is on the pipeline; the pipeline withdraws them");
  assert.equal(m.requestApplicationTransitionAllowed("rejected", "accepted"), false);
  assert.equal(m.requestApplicationTransitionAllowed("applied", "applied"), false);
  assert.deepEqual(m.requestApplicationOutbox("applied", APP, "person", "rec"), { kind: "request_application.received", recipient: "rec", dedupeKey: `request_application.received:${APP}` });
  assert.equal(m.requestApplicationOutbox("applied", APP, "person", null), null, "no recruiter yet: staff see it on the request");
  assert.deepEqual(m.requestApplicationOutbox("accepted", APP, "person", "rec"), { kind: "request_application.accepted", recipient: "person", dedupeKey: `request_application.accepted:${APP}` });
  assert.deepEqual(m.requestApplicationOutbox("rejected", APP, "person", null), { kind: "request_application.rejected", recipient: "person", dedupeKey: `request_application.rejected:${APP}` });
});

test("REC7B_VIEW the board query is closed and the view offers Apply only once and only while the request takes applications", () => {
  assert.deepEqual(m.parseOpenRequestQuery({}), { q: null, positionType: null, applied: false, page: 1 });
  assert.deepEqual(m.parseOpenRequestQuery({ q: "  cashier ", type: "part_time", applied: "1", page: "3" }), { q: "cashier", positionType: "part_time", applied: true, page: 3 });
  for (const bad of [{ gender: "male" }, { type: "contract" }, { page: "0" }, { applied: "yes" }, { q: "x".repeat(101) }, { q: "a\nb" }, { q: ["a", "b"] }]) assert.equal(m.parseOpenRequestQuery(bad as never), undefined, JSON.stringify(bad));
  const row = { id: REQ, org_name: "Sultan Co", store_name: "Salmiya", position_title: "Cashier", description: "Day shifts", position_type: "part_time", compensation_text: "2 KWD/h", pay_model: "hourly",
    period_start: "2026-12-01", period_end: "2026-12-31", location: null, status: "open" as const, created_at: "2026-11-17T08:00:00Z", application_id: null, application_status: null };
  const open = m.openRequestView(row);
  assert.deepEqual([open.canApply, open.application, open.period, open.postedAt], [true, null, { start: "2026-12-01", end: "2026-12-31" }, "2026-11-17T08:00:00.000Z"]);
  assert.equal(m.openRequestView({ ...row, application_id: APP, application_status: "applied" }).canApply, false, "applies once");
  assert.deepEqual(m.openRequestView({ ...row, application_id: APP, application_status: "applied" }).application, { applicationId: APP, status: "applied" });
  assert.equal(m.openRequestView({ ...row, status: "filled" }).canApply, false);
});
