import assert from "node:assert/strict";
import test from "node:test";

// Recruit R4 domain rules, loaded by URL so the mutation script can swap in a mutant.
const modulePath = process.env.REC4_INVITATIONS_MODULE ?? new URL("../src/invitations.js", import.meta.url).href;
const m = await import(modulePath) as typeof import("../src/invitations.js");
type S = import("../src/invitations.js").InvitationStatus;
const STATUSES: S[] = ["sent", "seen", "accepted", "declined", "withdrawn"];
const PERSON = new Set(["sent>seen", "sent>accepted", "sent>declined", "seen>accepted", "seen>declined"]);
const STAFF = new Set(["sent>withdrawn", "seen>withdrawn"]);

test("REC4_TRANSITIONS the person sees, accepts or declines an open invitation; staff only withdraw it; answers are final", () => {
  assert.deepEqual([...m.INVITATION_STATUSES], STATUSES);
  for (const from of STATUSES) for (const to of STATUSES) {
    assert.equal(m.invitationTransitionAllowed(from, to, "person"), PERSON.has(`${from}>${to}`), `person ${from} to ${to}`);
    assert.equal(m.invitationTransitionAllowed(from, to, "staff"), STAFF.has(`${from}>${to}`), `staff ${from} to ${to}`);
  }
});

test("REC4_ACCEPT accepting creates a contacted card, moves a suggestion on, keeps a later card, and is refused after a withdrawal", () => {
  assert.equal(m.acceptCardEffect(null), "insert_contacted");
  assert.equal(m.acceptCardEffect("suggested"), "move_contacted");
  for (const stage of ["contacted", "interviewing", "offered", "placed"] as const) assert.equal(m.acceptCardEffect(stage), "keep", stage);
  assert.equal(m.acceptCardEffect("withdrawn"), "refuse");
});

test("REC4_OUTBOX the person hears of sent and withdrawn; the assigned recruiter, else the inviter, hears the answer; seen is silent", () => {
  assert.deepEqual(m.invitationOutbox("sent", "p", "r", "i"), { kind: "invitation.sent", recipient: "p" });
  assert.deepEqual(m.invitationOutbox("withdrawn", "p", "r", "i"), { kind: "invitation.withdrawn", recipient: "p" });
  assert.deepEqual(m.invitationOutbox("accepted", "p", "r", "i"), { kind: "invitation.accepted", recipient: "r" });
  assert.deepEqual(m.invitationOutbox("declined", "p", null, "i"), { kind: "invitation.declined", recipient: "i" });
  assert.equal(m.invitationOutbox("seen", "p", "r", "i"), null);
});

test("REC4_VIEW the person sees company, store, period and pay; only open invitations can be answered; bodies are closed", () => {
  const row = { id: "i", request_id: "r", status: "seen" as const, org_name: "Co", store_name: "Avenues", position_title: "Cashier", position_type: "part_time", period_start: "2026-12-01", period_end: "2026-12-31", compensation_text: "3 KWD/h", pay_model: "hourly", location: null, created_at: "2026-11-17T10:00:00Z" };
  assert.deepEqual(m.invitationView(row), { invitationId: "i", status: "seen", company: "Co", store: "Avenues", positionTitle: "Cashier", positionType: "part_time", period: { start: "2026-12-01", end: "2026-12-31" }, pay: "3 KWD/h", payModel: "hourly", location: null, invitedAt: "2026-11-17T10:00:00.000Z", canAnswer: true });
  for (const status of ["accepted", "declined", "withdrawn"] as const) assert.equal(m.invitationView({ ...row, status }).canAnswer, false, status);
  assert.equal(m.invitationView({ ...row, period_end: null }).period, null);
  assert.deepEqual(m.parseInvitationCreate({ personId: "p1" }), { personId: "p1" });
  for (const bad of [null, {}, { personId: "" }, { personId: " p" }, { personId: "x".repeat(256) }, { personId: "p", requestId: "r" }, { personId: 5 }]) assert.equal(m.parseInvitationCreate(bad), undefined, JSON.stringify(bad));
});
