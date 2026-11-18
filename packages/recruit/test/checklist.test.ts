import assert from "node:assert/strict";
import test from "node:test";

// Recruit R2b domain rules, loaded by URL so the mutation script can swap in a mutant.
const modulePath = process.env.REC2B_CHECKLIST_MODULE ?? new URL("../src/checklist.js", import.meta.url).href;
const m = await import(modulePath) as typeof import("../src/checklist.js");
const OPS = ["root"];
const grant = (org_id: string, role: string, scope = "subtree") => ({ org_id, role, scope });
const ITEM = "123e4567-e89b-42d3-a456-426614174000";

test("REC2B_DECISIONS operator admins keep the checklist; operator staff, admins and recruiters write notes; companies never", () => {
  assert.equal(m.checklistAdminDecision([grant("root", "admin")], OPS), true);
  for (const role of ["staff", "recruiter", "org-owner"]) assert.equal(m.checklistAdminDecision([grant("root", role)], OPS), false, role);
  assert.equal(m.checklistAdminDecision([grant("root", "admin", "self")], OPS), false);
  for (const role of ["staff", "admin", "recruiter"]) {
    assert.equal(m.recruitNotesDecision([grant("root", role)], OPS), true, role);
    assert.equal(m.recruitNotesDecision([grant("co", role)], OPS), false, `company ${role}`);
    assert.equal(m.recruitNotesDecision([grant("root", role, "self")], OPS), false, `self ${role}`);
  }
  assert.equal(m.recruitNotesDecision([grant("root", "org-owner")], OPS), false);
  assert.equal(m.recruitNotesDecision([], OPS), false);
});

test("REC2B_ITEM checklist items take trimmed names, an optional Arabic name, a required flag and an order, from JSON or a form", () => {
  assert.deepEqual(m.parseChecklistItem({ nameEn: "  Call the store ", nameAr: "اتصل", required: true, sortOrder: 3 }), { nameEn: "Call the store", nameAr: "اتصل", required: true, sortOrder: 3 });
  assert.deepEqual(m.parseChecklistItem({ nameEn: "Brief", nameAr: "", required: "on", sortOrder: "12" }), { nameEn: "Brief", nameAr: null, required: true, sortOrder: 12 });
  assert.deepEqual(m.parseChecklistItem({ nameEn: "Brief" }), { nameEn: "Brief", nameAr: null, required: false, sortOrder: 0 });
  assert.deepEqual(m.parseChecklistItem({ nameEn: "x".repeat(100), sortOrder: 1000 }), { nameEn: "x".repeat(100), nameAr: null, required: false, sortOrder: 1000 });
  for (const bad of [null, [], "x", {}, { nameEn: "" }, { nameEn: "   " }, { nameEn: "x".repeat(101) }, { nameEn: "a\nb" }, { nameEn: "a", nameAr: 5 }, { nameEn: "a", required: "yes" },
    { nameEn: "a", sortOrder: 1001 }, { nameEn: "a", sortOrder: -1 }, { nameEn: "a", sortOrder: 1.5 }, { nameEn: "a", sortOrder: "1e2" }, { nameEn: "a", extra: 1 }]) {
    assert.equal(m.parseChecklistItem(bad), undefined, JSON.stringify(bad));
  }
});

test("REC2B_NOTE notes take a known type, multi-line text up to 5000 characters and optional step and person references", () => {
  assert.deepEqual(m.parseNote({ type: "phone_call", text: " Called.\nNo answer. ", checklistItemId: ITEM.toUpperCase(), cardId: "" }), { type: "phone_call", text: "Called.\nNo answer.", checklistItemId: ITEM, cardId: null });
  assert.deepEqual(m.parseNote({ type: "task", text: "x".repeat(5000) }), { type: "task", text: "x".repeat(5000), checklistItemId: null, cardId: null });
  for (const bad of [null, { type: "note", text: "a" }, { type: "email", text: "" }, { type: "email", text: "x".repeat(5001) }, { type: "email", text: "a\u0000b" }, { type: "email", text: "a", cardId: "nope" },
    { type: "email", text: "a", checklistItemId: 5 }, { type: "email", text: "a", requestId: ITEM }]) {
    assert.equal(m.parseNote(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual([...m.NOTE_TYPES], ["internal_note", "phone_call", "email", "meeting", "interview", "task"]);
});

test("REC2B_PROGRESS steps follow the order; a step is done once a note names it; only required steps count as left", () => {
  const items = [
    { id: "b", name_en: "Brief", name_ar: null, required: true, sort_order: 2 },
    { id: "a", name_en: "Call", name_ar: "اتصل", required: true, sort_order: 1 },
    { id: "c", name_en: "Optional", name_ar: null, required: false, sort_order: 2 },
  ];
  const none = m.checklistProgress(items, new Set());
  assert.deepEqual(none.steps.map((s) => s.itemId), ["a", "b", "c"]);
  assert.equal(none.requiredRemaining, 2);
  const some = m.checklistProgress(items, new Set(["a", "c", "gone"]));
  assert.deepEqual(some.steps.map((s) => s.done), [true, false, true]);
  assert.equal(some.requiredRemaining, 1);
  assert.equal(m.checklistProgress(items, new Set(["a", "b"])).requiredRemaining, 0);
});

test("REC2B_LEGACY legacy note types map one to one; generated and unknown types are reported", () => {
  assert.deepEqual(m.legacyNoteType("Internal Note"), { kind: "mapped", type: "internal_note" });
  assert.deepEqual(m.legacyNoteType("Phone Call"), { kind: "mapped", type: "phone_call" });
  for (const value of ["Suggestion", "Invitation", "", "constructor"]) assert.deepEqual(m.legacyNoteType(value), { kind: "unmapped", value });
});
