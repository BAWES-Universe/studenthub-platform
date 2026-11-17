import assert from "node:assert/strict";
import test from "node:test";

// Recruit R1 domain rules. The module is loaded by URL so the mutation script can swap in a mutant.
const modulePath = process.env.REC1_REQUESTS_MODULE ?? new URL("../src/requests.js", import.meta.url).href;
const m = await import(modulePath) as typeof import("../src/requests.js");
type Status = import("../src/requests.js").RequestStatus;

const ALLOWED = new Set(["draft>open", "draft>closed", "open>filling", "open>closed", "filling>filled", "filling>closed", "filled>filling", "filled>closed"]);
const STATUSES: Status[] = ["draft", "open", "filling", "filled", "closed"];

test("REC1_TRANSITIONS every ordered pair of statuses is allowed exactly when listed, and closed is final", () => {
  assert.deepEqual([...m.REQUEST_STATUSES], STATUSES);
  for (const from of STATUSES) for (const to of STATUSES) {
    assert.equal(m.requestTransitionAllowed(from, to), ALLOWED.has(`${from}>${to}`), `${from} to ${to}`);
  }
  for (const to of STATUSES) assert.equal(m.requestTransitionAllowed("closed", to), false, `closed to ${to}`);
  assert.equal(m.REQUEST_TRANSITIONS.length, ALLOWED.size);
});

test("REC1_LEGACY_MAP the six legacy statuses map to exactly one status each, anything else is unmapped", () => {
  assert.deepEqual(m.legacyRequestStatus("pending"), { kind: "mapped", status: "open", closeReason: null });
  assert.deepEqual(m.legacyRequestStatus("started"), { kind: "mapped", status: "filling", closeReason: null });
  assert.deepEqual(m.legacyRequestStatus("re_work"), { kind: "mapped", status: "filling", closeReason: null });
  assert.deepEqual(m.legacyRequestStatus("delivered"), { kind: "mapped", status: "filled", closeReason: null });
  assert.deepEqual(m.legacyRequestStatus("finished_by_recruitment"), { kind: "mapped", status: "closed", closeReason: "fulfilled" });
  assert.deepEqual(m.legacyRequestStatus("cancelled"), { kind: "mapped", status: "closed", closeReason: "cancelled" });
  for (const value of ["", "Pending", "open", "finished", "2", " pending"]) assert.deepEqual(m.legacyRequestStatus(value), { kind: "unmapped", value });
});

const grant = (org_id: string, role: string, scope = "self") => ({ org_id, role, scope });
const OPS = ["root"];

test("REC1_CANCEL owners, staff and admin may change status; a recruiter grantee may create and read but not close", () => {
  for (const role of ["org-owner", "recruiter", "staff", "admin"]) {
    assert.equal(m.requestCreateDecision([grant("co", role)], "co", ["root"], OPS), true, `${role} creates`);
    assert.equal(m.requestReadDecision([grant("co", role)], "co", ["root"], OPS), true, `${role} reads`);
  }
  for (const role of ["org-owner", "staff", "admin"]) assert.equal(m.requestTransitionDecision([grant("co", role)], "co", ["root"], OPS), true, `${role} closes`);
  assert.equal(m.requestTransitionDecision([grant("co", "recruiter")], "co", ["root"], OPS), false, "recruiter cannot close");
  for (const role of ["finance", "candidate", "store-manager"]) {
    assert.equal(m.requestCreateDecision([grant("co", role)], "co", ["root"], OPS), false, `${role} cannot create`);
    assert.equal(m.requestTransitionDecision([grant("co", role)], "co", ["root"], OPS), false, `${role} cannot close`);
  }
  assert.equal(m.requestTransitionDecision([grant("root", "staff", "subtree")], "co", ["root"], OPS), true, "staff through subtree");
  assert.equal(m.requestTransitionDecision([grant("root", "staff", "self")], "co", ["root"], OPS), false, "self grant on an ancestor does not reach");
  assert.equal(m.requestCreateDecision([grant("other", "org-owner")], "co", ["root"], OPS), false, "another company's owner");
  assert.equal(m.requestCreateDecision([grant("root", "admin", "subtree")], "root", [], OPS), false, "operator organizations raise no requests");
});

test("REC1_STAFF the staff queue is for staff and admin through a subtree grant on an operator organization", () => {
  assert.equal(m.recruitStaffDecision([grant("root", "staff", "subtree")], OPS), true);
  assert.equal(m.recruitStaffDecision([grant("root", "admin", "subtree")], OPS), true);
  assert.equal(m.recruitStaffDecision([grant("root", "staff", "self")], OPS), false);
  assert.equal(m.recruitStaffDecision([grant("co", "staff", "subtree")], OPS), false);
  assert.equal(m.recruitStaffDecision([grant("root", "org-owner", "subtree")], OPS), false);
});

const STORE = "6f9619ff-8b86-4011-b42d-00cf4fc964ff";
const valid = { storeId: STORE, positionTitle: "  Cashier ", description: "Front till\nweekends", compensationText: "3 KWD / hour", positionType: "part_time", headcount: 4 };

test("REC1_CREATE fields are trimmed, bounded and closed sets; defaults are any gender, priority 0, open", () => {
  assert.deepEqual(m.parseRequestFields(valid), {
    storeId: STORE, positionTitle: "Cashier", description: "Front till\nweekends", compensationText: "3 KWD / hour", positionType: "part_time", headcount: 4,
    periodStart: null, periodEnd: null, payModel: null, gender: "any", location: null, priority: 0, draft: false,
  });
  const full = m.parseRequestFields({ ...valid, periodStart: "2026-12-01", periodEnd: "2026-12-31", payModel: "hourly", gender: "female", location: "Avenues", priority: "3", headcount: "2", draft: true });
  assert.equal(full?.payModel, "hourly");
  assert.equal(full?.headcount, 2);
  assert.equal(full?.draft, true);
  const refused: Record<string, unknown>[] = [
    { ...valid, positionTitle: "" }, { ...valid, positionTitle: "x".repeat(256) }, { ...valid, positionTitle: "a\nb" }, { ...valid, description: "a\u0000b" },
    { ...valid, positionType: "contract" }, { ...valid, headcount: 0 }, { ...valid, headcount: 1.5 }, { ...valid, payModel: "weekly" },
    { ...valid, gender: "unknown" }, { ...valid, periodStart: "2026-12-31", periodEnd: "2026-12-01" }, { ...valid, periodStart: "2026-02-30", periodEnd: "2026-03-01" },
    { ...valid, periodStart: "2026-12-01" }, { ...valid, storeId: "not-a-store" }, { ...valid, extra: 1 }, { ...valid, priority: 11 },
  ];
  for (const value of refused) assert.equal(m.parseRequestFields(value), undefined, JSON.stringify(value));
  assert.equal(m.parseRequestFields({ ...valid, positionTitle: "x".repeat(255) })?.positionTitle.length, 255);
});

test("REC1_TRANSITION_BODY a close needs a reason and nothing else carries one", () => {
  assert.deepEqual(m.parseRequestTransition({ to: "closed", closeReason: "cancelled" }), { to: "closed", closeReason: "cancelled" });
  assert.deepEqual(m.parseRequestTransition({ to: "filling" }), { to: "filling", closeReason: null });
  assert.equal(m.parseRequestTransition({ to: "closed" }), undefined);
  assert.equal(m.parseRequestTransition({ to: "open", closeReason: "fulfilled" }), undefined);
  assert.equal(m.parseRequestTransition({ to: "archived" }), undefined);
  assert.equal(m.parseRequestTransition({ to: "open", extra: true }), undefined);
});

test("REC1_VIEW views expose exactly their keys and offer only allowed next statuses", () => {
  const row = {
    id: STORE, org_id: "co", org_name: "Co", store_id: STORE, store_name: "Avenues", position_title: "Cashier", description: "d", compensation_text: "c",
    position_type: "part_time" as const, headcount: 2, period_start: null, period_end: null, pay_model: null, gender: "any" as const, location: null, priority: 0,
    status: "filled" as const, close_reason: null, assigned: true, created_at: "2026-11-17T10:00:00.000Z", updated_at: "2026-11-17T11:00:00.000Z", cursor_at: "2026-11-17T10:00:00.000000Z",
  };
  assert.deepEqual(Object.keys(m.requestSummaryView(row)).sort(), ["closeReason", "headcount", "lastChange", "orgId", "organizationName", "positionTitle", "requestId", "status", "storeName"]);
  assert.deepEqual(m.requestView(row, true).allowedTransitions, ["filling", "closed"]);
  assert.deepEqual(m.requestView(row, false).allowedTransitions, []);
});

test("REC1_CURSOR the cursor round-trips the microsecond key and refuses anything else", () => {
  const cursor = { createdAt: "2026-11-17T10:00:00.123456Z", id: STORE };
  assert.deepEqual(m.decodeRequestCursor(m.encodeRequestCursor(cursor)), cursor);
  assert.equal(m.decodeRequestCursor("!!"), undefined);
  assert.equal(m.decodeRequestCursor(Buffer.from(JSON.stringify(["2026-11-17T10:00:00Z", STORE])).toString("base64url")), undefined);
  assert.equal(m.decodeRequestCursor(Buffer.from(JSON.stringify(["2026-11-17T10:00:00.123456Z", "x"])).toString("base64url")), undefined);
});
