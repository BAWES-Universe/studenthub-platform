import assert from "node:assert/strict";
import test from "node:test";

// Recruit R6 domain rules, loaded by URL so the mutation script can swap in a mutant.
const modulePath = process.env.REC6_INTERVIEWS_MODULE ?? new URL("../src/interviews.js", import.meta.url).href;
const m = await import(modulePath) as typeof import("../src/interviews.js");
type S = import("../src/interviews.js").InterviewStatus;
const CARD = "323e4567-e89b-42d3-a456-426614174000";
const NOW = new Date("2026-11-17T12:00:00Z");

test("REC6_RULES interviews belong to live stages; only a scheduled one closes; evaluations complete or correct, never revive", () => {
  assert.deepEqual(["suggested", "contacted", "interviewing", "offered", "placed", "withdrawn"].filter(m.interviewStageAllowed), ["contacted", "interviewing", "offered"]);
  const all: S[] = ["scheduled", "completed", "cancelled"];
  const moves = all.flatMap((a) => all.filter((b) => m.interviewTransitionAllowed(a, b)).map((b) => `${a}>${b}`));
  assert.deepEqual(moves, ["scheduled>completed", "scheduled>cancelled"]);
  assert.deepEqual(all.filter(m.evaluationAllowed), ["scheduled", "completed"]);
  const ops = ["root"];
  assert.equal(m.internalNoteDecision([{ org_id: "root", role: "staff", scope: "subtree" }], ops), true);
  assert.equal(m.internalNoteDecision([{ org_id: "root", role: "recruiter", scope: "subtree" }], ops), true);
  assert.equal(m.internalNoteDecision([{ org_id: "root", role: "staff", scope: "self" }], ops), false, "self scope is not operator staff");
  assert.equal(m.internalNoteDecision([{ org_id: "acme", role: "org-owner", scope: "subtree" }], ops), false, "a company never writes internal notes");
  assert.equal(m.internalNoteDecision([{ org_id: "acme", role: "staff", scope: "subtree" }], ops), false, "company staff are not operator staff");
  assert.equal(m.interviewCompanyDecision([{ org_id: "acme", role: "org-owner", scope: "self" }], "acme", ["root"], ops), true, "the company owner");
  assert.equal(m.interviewCompanyDecision([{ org_id: "root", role: "recruiter", scope: "subtree" }], "acme", ["root"], ops), false, "an operator recruiter acts through the pipeline, not as the company");
});

test("REC6_PARSE a schedule is a Kuwait wall-clock or offset instant within a year; the form's strings are read; nothing else is accepted", () => {
  const ok = m.parseInterview({ cardId: CARD.toUpperCase(), scheduledAt: "2026-11-18T10:30", durationMinutes: "45", mode: "in_person", location: "  Avenues, gate 3 " }, NOW);
  assert.deepEqual(ok, { cardId: CARD, scheduledAt: "2026-11-18T07:30:00.000Z", durationMinutes: 45, mode: "in_person", location: "Avenues, gate 3" });
  assert.equal(m.parseInterview({ cardId: CARD, scheduledAt: "2026-11-18T10:30:00+03:00", mode: "phone" }, NOW)!.durationMinutes, 30, "30 minutes by default");
  assert.equal(m.parseInterview({ cardId: CARD, scheduledAt: "2026-11-18T10:30:00+03:00", mode: "phone" }, NOW)!.scheduledAt, "2026-11-18T07:30:00.000Z");
  assert.equal(m.parseInterview({ cardId: CARD, scheduledAt: "2026-11-16T16:00", mode: "video" }, NOW)?.scheduledAt, "2026-11-16T13:00:00.000Z", "yesterday's interview may still be recorded");
  for (const bad of [
    { cardId: CARD, scheduledAt: "2026-11-15T10:00", mode: "video" },
    { cardId: CARD, scheduledAt: "2027-11-19T10:00", mode: "video" },
    { cardId: CARD, scheduledAt: "2026-02-30T10:00", mode: "video" },
    { cardId: CARD, scheduledAt: "2026-11-18 10:00", mode: "video" },
    { cardId: CARD, scheduledAt: "2026-11-18T10:00", mode: "teleport" },
    { cardId: CARD, scheduledAt: "2026-11-18T10:00", mode: "video", durationMinutes: 4 },
    { cardId: CARD, scheduledAt: "2026-11-18T10:00", mode: "video", durationMinutes: 481 },
    { cardId: CARD, scheduledAt: "2026-11-18T10:00", mode: "video", durationMinutes: 30.5 },
    { cardId: CARD, scheduledAt: "2026-11-18T10:00", mode: "video", location: "line\nbreak" },
    { cardId: CARD, scheduledAt: "2026-11-18T10:00", mode: "video", location: "x".repeat(501) },
    { cardId: "nope", scheduledAt: "2026-11-18T10:00", mode: "video" },
    { cardId: CARD, scheduledAt: "2026-11-18T10:00", mode: "video", extra: 1 },
  ]) assert.equal(m.parseInterview(bad, NOW), undefined, JSON.stringify(bad));
  assert.equal(m.kuwaitWallClock("2026-11-18T21:30:00Z"), "2026-11-19 00:30");
});

test("REC6_EVALUATION outcome and an optional 1 to 5 rating; a no-show has no rating; notes are bounded and kept apart", () => {
  assert.deepEqual(m.parseEvaluation({ outcome: "passed", rating: "4", sharedNote: " Good fit ", internalNote: "" }), { outcome: "passed", rating: 4, sharedNote: "Good fit", internalNote: null });
  assert.deepEqual(m.parseEvaluation({ outcome: "no_show", rating: "", sharedNote: "Line one\nLine two" }), { outcome: "no_show", rating: null, sharedNote: "Line one\nLine two", internalNote: null });
  for (const bad of [{ outcome: "no_show", rating: 2 }, { outcome: "passed", rating: 6 }, { outcome: "passed", rating: 0 }, { outcome: "maybe" }, { outcome: "passed", sharedNote: "x".repeat(5001) }, { outcome: "passed", internalNote: "bell\u0007" }, { outcome: "passed", other: 1 }])
    assert.equal(m.parseEvaluation(bad), undefined, JSON.stringify(bad));
});

test("REC6_VIEW the internal note reaches only internal viewers; the person sees time, place and outcome only; the outbox tells the person", () => {
  const row = { id: "i1", card_id: "c1", person_name: "Noor", scheduled_at: "2026-11-18T07:30:00Z", duration_minutes: 30, mode: "phone" as const, location: null, status: "completed" as const, outcome: "passed" as const, rating: 4, shared_note: "Good", internal_note: "Staff only", scheduled_by_name: "Sara", evaluation_version: 2 };
  assert.equal(m.interviewView(row, true).internalNote, "Staff only");
  assert.equal("internalNote" in m.interviewView(row, false), false);
  assert.deepEqual([m.interviewView(row, false).kuwaitTime, m.interviewView(row, false).evaluationVersion, m.interviewView(row, false).sharedNote], ["2026-11-18 10:30", 2, "Good"]);
  const mine = m.personInterviewView({ ...row, org_name: "Acme", store_name: "Avenues", position_title: "Cashier" });
  assert.deepEqual(Object.keys(mine).sort(), ["company", "durationMinutes", "interviewId", "kuwaitTime", "location", "mode", "outcome", "positionTitle", "scheduledAt", "status", "store"]);
  assert.deepEqual(m.interviewOutbox("interview.scheduled", "i1", "p1"), { kind: "interview.scheduled", recipient: "p1", dedupeKey: "interview.scheduled:i1" });
  assert.notEqual(m.interviewOutbox("interview.cancelled", "i1", "p1").dedupeKey, m.interviewOutbox("interview.scheduled", "i1", "p1").dedupeKey);
});
