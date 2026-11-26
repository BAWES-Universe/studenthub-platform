import assert from "node:assert/strict";
import test from "node:test";

import { CANDIDATE_DOCUMENT_ADMISSION } from "../../../packages/private-documents/src/candidate-lifecycle.js";
import { DOCUMENT_COLUMNS, M2_DOCUMENT_SOURCES, legacyDocumentKeys, mapLegacyDocuments } from "../src/m2-documents.js";
import { M1_SOURCES, mapLegacyCandidates } from "../src/m1-people.js";

// Synthetic rows only. Object names are made up; "Secret" marks a name that must never be reported.
const TODAY = "2026-11-26";
const candidate = (id: number | string, extra: Record<string, unknown> = {}) => ({
  candidate_id: id, deleted: 0, candidate_name: "Test Person", candidate_personal_photo: null, candidate_resume: null,
  candidate_civil_photo_front: null, candidate_civil_photo_back: null, ...extra,
});
const map = (rows: readonly Record<string, unknown>[]) => {
  const { people } = mapLegacyCandidates({ candidate: rows, country: [], university: [], area: [] }, TODAY);
  return mapLegacyDocuments(rows, people);
};

test("the four kinds are the platform's document types and read only their own columns", () => {
  assert.deepEqual(DOCUMENT_COLUMNS.map(([kind]) => kind).sort(), Object.keys(CANDIDATE_DOCUMENT_ADMISSION).sort());
  assert.deepEqual(M2_DOCUMENT_SOURCES.candidate, ["candidate_id", ...DOCUMENT_COLUMNS.map(([, c]) => c)]);
  assert.ok(!M2_DOCUMENT_SOURCES.candidate.includes("candidate_video" as never), "video is excluded (D3)");
  // M-1's snapshot never reads a document location.
  for (const [, column] of DOCUMENT_COLUMNS) assert.ok(!(M1_SOURCES.candidate as readonly string[]).includes(column));
});

test("each kind resolves to legacy's own bucket keys, in legacy's probe order", () => {
  assert.deepEqual(legacyDocumentKeys("personal-photo", "candidate-profile-photos/a.jpg"), ["candidate-profile-photos/a.jpg"]);
  assert.deepEqual(legacyDocumentKeys("personal-photo", "photos/a.jpg"), ["photos/a.jpg"]);
  assert.deepEqual(legacyDocumentKeys("personal-photo", "a.jpg"), ["candidate-profile-photos/a.jpg", "photos/a.jpg"]);
  assert.deepEqual(legacyDocumentKeys("personal-photo", "tmp/x/a.jpg"), ["candidate-profile-photos/a.jpg", "photos/a.jpg"]);
  for (const kind of ["civil-id-front", "civil-id-back"] as const) {
    assert.deepEqual(legacyDocumentKeys(kind, "photos/b.png"), ["photos/b.png"]);
    assert.deepEqual(legacyDocumentKeys(kind, "candidate-civil-id/x/b.png"), ["photos/b.png"]);
    assert.deepEqual(legacyDocumentKeys(kind, "b.png"), ["photos/b.png"]);
  }
  assert.deepEqual(legacyDocumentKeys("resume", "c.pdf"), ["candidate-resume/c.pdf"]);
});

test("imported people get one row per set column, ordered by legacy id then kind; unset values get none", () => {
  const { documents, issues } = map([
    candidate(20, { candidate_resume: "cv-20.pdf", candidate_personal_photo: " /photos/p20.jpg\t" }),
    candidate(3, { candidate_civil_photo_back: "back3.png", candidate_civil_photo_front: "front3.png", candidate_personal_photo: " / " }),
    candidate(4, { candidate_resume: "", candidate_civil_photo_back: "\n" }),
  ]);
  assert.deepEqual(issues, []);
  assert.deepEqual(documents, [
    { legacyId: "3", kind: "civil-id-front", keys: ["photos/front3.png"] },
    { legacyId: "3", kind: "civil-id-back", keys: ["photos/back3.png"] },
    { legacyId: "20", kind: "personal-photo", keys: ["photos/p20.jpg"] },
    { legacyId: "20", kind: "resume", keys: ["candidate-resume/cv-20.pdf"] },
  ]);
});

test("only candidates M-1 imports are mapped: archived, duplicate and unusable ids are skipped", () => {
  const { documents, issues } = map([
    candidate(1, { deleted: 1, candidate_resume: "gone.pdf" }),
    candidate(2, { candidate_resume: "a.pdf" }), candidate(2, { candidate_resume: "b.pdf" }),
    candidate("x", { candidate_resume: "c.pdf" }),
    candidate(5, { candidate_resume: "five.pdf" }),
  ]);
  assert.deepEqual(issues, []);
  assert.deepEqual(documents, [{ legacyId: "5", kind: "resume", keys: ["candidate-resume/five.pdf"] }]);
});

test("a value that cannot name one object safely is document.badKey, by column, never by value", () => {
  const bad = ["../Secret.pdf", "a/../Secret.pdf", "a//Secret.pdf", "./Secret.pdf", "a\\Secret.pdf", "Secret\u0000.pdf",
    "Secret​.pdf", "Secret\n.pdf", `${"S".repeat(961)}`, 42, { key: "Secret" }];
  const rows = bad.map((value, i) => candidate(100 + i, { candidate_resume: value }));
  const { documents, issues } = map(rows);
  assert.deepEqual(documents, []);
  assert.deepEqual(issues, bad.map((_, i) => ({ rule: "document.badKey", legacyId: String(100 + i), field: "candidate_resume" })));
  assert.ok(!JSON.stringify(issues).includes("Secret"));
  // A CV key is legacy's stored value verbatim: a value that would need trimming or slash removal is held, never rewritten.
  const altered = ["  cv.pdf", "cv.pdf ", "/cv.pdf", "   ", "\u00a0cv.pdf"];
  const held = map(altered.map((value, i) => candidate(200 + i, { candidate_resume: value })));
  assert.deepEqual(held.documents, []);
  assert.deepEqual(held.issues, altered.map((_, i) => ({ rule: "document.badKey", legacyId: String(200 + i), field: "candidate_resume" })));
  // Spaces inside a name and non-ASCII letters are legacy object names, not refusals.
  assert.deepEqual(map([candidate(7, { candidate_resume: "My CV نور.pdf" })]).documents,
    [{ legacyId: "7", kind: "resume", keys: ["candidate-resume/My CV نور.pdf"] }]);
});

test("one object named by two imported people is recorded for neither, whichever probe would find it", () => {
  const { documents, issues } = map([
    // A bare photo name probes photos/<name>, which another person's civil ID front names.
    candidate(11, { candidate_personal_photo: "Secret-shared.jpg", candidate_resume: "own-11.pdf" }),
    candidate(12, { candidate_civil_photo_front: "Secret-shared.jpg" }),
    // The same CV name on two people.
    candidate(13, { candidate_resume: "Secret-cv.pdf" }),
    candidate(14, { candidate_resume: "Secret-cv.pdf" }),
    candidate(15, { candidate_resume: "Secret-cv.pdf" }),
    // One person's photo and civil ID naming the same object is still one owner.
    candidate(16, { candidate_personal_photo: "photos/own-16.jpg", candidate_civil_photo_front: "own-16.jpg" }),
  ]);
  assert.deepEqual(documents, [
    { legacyId: "11", kind: "resume", keys: ["candidate-resume/own-11.pdf"] },
    { legacyId: "16", kind: "personal-photo", keys: ["photos/own-16.jpg"] },
    { legacyId: "16", kind: "civil-id-front", keys: ["photos/own-16.jpg"] },
  ]);
  assert.deepEqual(issues, [
    { rule: "document.sharedObject", legacyId: "11", field: "candidate_personal_photo", target: "12" },
    { rule: "document.sharedObject", legacyId: "12", field: "candidate_civil_photo_front", target: "11" },
    { rule: "document.sharedObject", legacyId: "13", field: "candidate_resume", target: "14" },
    { rule: "document.sharedObject", legacyId: "14", field: "candidate_resume", target: "13" },
    { rule: "document.sharedObject", legacyId: "15", field: "candidate_resume", target: "13" },
  ]);
  assert.ok(!JSON.stringify(issues).includes("Secret"));
});

test("rows M-1 does not import still claim their objects, by legacy's lenient rules and every probe", () => {
  const { documents, issues } = map([
    // An archived row's CV and a duplicate-id row's photo probe (the fallback photos/<name>).
    candidate(30, { candidate_resume: "Secret-a.pdf", candidate_civil_photo_front: "Secret-b.png" }),
    candidate(31, { deleted: 1, candidate_resume: "Secret-a.pdf" }),
    candidate(32, { candidate_personal_photo: "Secret-b.png" }), candidate(32, {}),
    // A row with no usable id, written the way only legacy's lenient reading accepts (outer spaces, a trailing slash).
    candidate(33, { candidate_personal_photo: "Secret-c.jpg" }),
    candidate("legacy-x", { candidate_civil_photo_back: " /candidate-civil-id/Secret-c.jpg/\n" }),
    candidate(34, { candidate_resume: "own-34.pdf" }),
  ]);
  assert.deepEqual(documents, [{ legacyId: "34", kind: "resume", keys: ["candidate-resume/own-34.pdf"] }]);
  assert.deepEqual(issues, [
    { rule: "document.sharedObject", legacyId: "30", field: "candidate_resume", target: "31" },
    { rule: "document.sharedObject", legacyId: "30", field: "candidate_civil_photo_front", target: "32" },
    // The only other claimant has no usable id: blocked, and no target is named.
    { rule: "document.sharedObject", legacyId: "33", field: "candidate_personal_photo" },
  ]);
  assert.ok(!JSON.stringify(issues).includes("Secret"));
});

test("many people naming one placeholder object are all held, each naming the lowest other id", () => {
  const n = 5000;
  const rows = Array.from({ length: n }, (_, i) => candidate(n - i, { candidate_resume: "placeholder.pdf" }));
  const { documents, issues } = map(rows);
  assert.deepEqual(documents, []);
  assert.equal(issues.length, n);
  assert.deepEqual(issues[0], { rule: "document.sharedObject", legacyId: "1", field: "candidate_resume", target: "2" });
  assert.ok(issues.slice(1).every((issue) => issue.target === "1"));
});

test("the mapping is deterministic whatever the row order", () => {
  const rows = [
    candidate(9, { candidate_resume: "n.pdf", candidate_personal_photo: "p.jpg" }),
    candidate(10, { candidate_resume: "../x" }),
    candidate(8, { candidate_civil_photo_back: "q.png" }),
  ];
  assert.deepEqual(map([...rows].reverse()), map(rows));
});
