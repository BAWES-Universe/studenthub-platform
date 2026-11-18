import assert from "node:assert/strict";
import test from "node:test";

// Recruit R2 domain rules, loaded by URL so the mutation script can swap in a mutant.
const modulePath = process.env.REC2_PIPELINE_MODULE ?? new URL("../src/pipeline.js", import.meta.url).href;
const m = await import(modulePath) as typeof import("../src/pipeline.js");
type Stage = import("../src/pipeline.js").PipelineStage;

const STAGES: Stage[] = ["suggested", "contacted", "interviewing", "offered", "placed", "withdrawn"];
const ALLOWED = new Set(["suggested>contacted", "suggested>withdrawn", "contacted>interviewing", "contacted>offered", "contacted>withdrawn", "interviewing>offered", "interviewing>withdrawn", "offered>placed", "offered>withdrawn"]);
const OPS = ["root"];
const grant = (org_id: string, role: string, scope = "subtree") => ({ org_id, role, scope });

test("REC2_STAGES every ordered pair of stages is allowed exactly when listed; placed and withdrawn are final", () => {
  assert.deepEqual([...m.PIPELINE_STAGES], STAGES);
  for (const from of STAGES) for (const to of STAGES) assert.equal(m.pipelineTransitionAllowed(from, to), ALLOWED.has(`${from}>${to}`), `${from} to ${to}`);
  for (const to of STAGES) {
    assert.equal(m.pipelineTransitionAllowed("placed", to), false);
    assert.equal(m.pipelineTransitionAllowed("withdrawn", to), false);
  }
  assert.deepEqual([...m.OPEN_PIPELINE_STAGES], ["suggested", "contacted", "interviewing", "offered"]);
  assert.equal(m.parsePipelineStage("archived"), undefined);
  assert.equal(m.parsePipelineStage("placed"), "placed");
});

test("REC2_REQUEST_STATUS the first card fills an open request, reaching headcount fills it, anything past is left alone", () => {
  assert.equal(m.requestStatusAfterPipeline("open", { kind: "card_added" }), "filling");
  for (const status of ["draft", "filling", "filled", "closed"] as const) assert.equal(m.requestStatusAfterPipeline(status, { kind: "card_added" }), null, status);
  assert.equal(m.requestStatusAfterPipeline("filling", { kind: "placed", placedCount: 2, headcount: 3 }), null);
  assert.equal(m.requestStatusAfterPipeline("filling", { kind: "placed", placedCount: 3, headcount: 3 }), "filled");
  assert.equal(m.requestStatusAfterPipeline("filling", { kind: "placed", placedCount: 4, headcount: 3 }), "filled");
  for (const status of ["open", "filled", "closed"] as const) assert.equal(m.requestStatusAfterPipeline(status, { kind: "placed", placedCount: 9, headcount: 1 }), null, status);
  assert.equal(m.requestAcceptsCards("open"), true);
  assert.equal(m.requestAcceptsCards("filling"), true);
  for (const status of ["draft", "filled", "closed"] as const) assert.equal(m.requestAcceptsCards(status), false, status);
});

test("REC2_AUTHORITY staff and admin on an operator assign; only the assigned recruiter or a lead moves cards", () => {
  assert.equal(m.pipelineAssignDecision([grant("root", "staff")], OPS), true);
  assert.equal(m.pipelineAssignDecision([grant("root", "admin")], OPS), true);
  assert.equal(m.pipelineAssignDecision([grant("root", "staff", "self")], OPS), false);
  assert.equal(m.pipelineAssignDecision([grant("co", "admin")], OPS), false);
  assert.equal(m.pipelineAssignDecision([grant("root", "recruiter")], OPS), false);
  assert.equal(m.pipelineLeadDecision([grant("root", "admin")], OPS), true);
  assert.equal(m.pipelineLeadDecision([grant("root", "staff")], OPS), false);
  assert.equal(m.pipelineRecruiterEligible([grant("root", "recruiter")], OPS), true);
  assert.equal(m.pipelineRecruiterEligible([grant("root", "recruiter", "self")], OPS), false, "placement needs subtree scope");
  assert.equal(m.pipelineRecruiterEligible([grant("root", "staff")], OPS), true);
  assert.equal(m.pipelineRecruiterEligible([grant("co", "recruiter")], OPS), false, "a company recruiter is not a StudentHub recruiter");
  assert.equal(m.pipelineAuthority("a", "a", false, true), true);
  assert.equal(m.pipelineAuthority("a", "a", false, false), false, "an assigned recruiter whose recruiter grant was revoked has no authority");
  assert.equal(m.pipelineAuthority("b", "a", false, true), false);
  assert.equal(m.pipelineAuthority("b", null, false, true), false);
  assert.equal(m.pipelineAuthority("b", "a", true, false), true);
});

test("REC2_LEGACY suggestion statuses seed cards: suggested and accepted map, anything else is reported", () => {
  assert.deepEqual(m.legacySuggestionStage(1), { kind: "mapped", stage: "suggested" });
  assert.deepEqual(m.legacySuggestionStage(3), { kind: "mapped", stage: "placed" });
  for (const value of [0, 2, 4, 9]) assert.deepEqual(m.legacySuggestionStage(value), { kind: "unmapped", value });
});

test("REC2_VIEW cards group by stage, carry their own history oldest first, and offer moves only to those who may move", () => {
  const cards = [
    { id: "c1", person_principal_id: "p1", person_name: "Noor", stage: "contacted" as const, updated_at: "2026-11-17T10:00:00Z" },
    { id: "c2", person_principal_id: "p2", person_name: null, stage: "placed" as const, updated_at: "2026-11-17T10:00:00Z" },
  ];
  const events = [
    { card_id: "c1", from_stage: "suggested" as const, to_stage: "contacted" as const, actor_name: "Rec", at: "2026-11-17T11:00:00Z" },
    { card_id: "c1", from_stage: null, to_stage: "suggested" as const, actor_name: "Rec", at: "2026-11-17T10:00:00Z" },
  ];
  const view = m.pipelineView(cards, events, true);
  assert.deepEqual(Object.keys(view), STAGES);
  assert.deepEqual(view.contacted[0]!.allowedMoves, ["interviewing", "offered", "withdrawn"]);
  assert.deepEqual(view.contacted[0]!.history.map((h) => h.to), ["suggested", "contacted"]);
  assert.deepEqual(view.placed[0]!.allowedMoves, []);
  assert.deepEqual(m.pipelineView(cards, events, false).contacted[0]!.allowedMoves, []);
});
