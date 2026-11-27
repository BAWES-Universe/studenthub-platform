import assert from "node:assert/strict";
import test from "node:test";

import { M2_CANDIDATE_COUNT_SQL, M2_RUN_SOURCES, M2InputError, m2SourceSql, planM2, readM2Sources } from "../src/m2-run.js";
import type { LegacyReader } from "../src/twin/journey.js";

// Synthetic rows only.
const candidate = (id: number, extra: Record<string, unknown> = {}) => ({
  candidate_id: id, deleted: 0, candidate_name: "Test Person", candidate_personal_photo: null, candidate_resume: null,
  candidate_civil_photo_front: null, candidate_civil_photo_back: null, ...extra,
});

/** A mirror whose candidate count can change between calls. */
function mirror(candidates: Record<string, unknown>[], counts: number[]) {
  const queries: string[] = [];
  const reader: LegacyReader = {
    async rows(sql) {
      queries.push(sql);
      if (sql === M2_CANDIDATE_COUNT_SQL) return [{ n: counts.shift() }];
      if (sql === m2SourceSql("candidate")) return candidates;
      return [];
    },
  };
  return { reader, queries };
}

test("the candidate read carries M-1's columns and the four document columns, nothing else", () => {
  for (const c of ["candidate_personal_photo", "candidate_resume", "candidate_civil_photo_front", "candidate_civil_photo_back", "deleted"]) {
    assert.ok((M2_RUN_SOURCES.candidate as readonly string[]).includes(c));
  }
  for (const c of ["candidate_email", "candidate_phone", "candidate_civil_id", "candidate_password_hash", "candidate_video"]) {
    assert.ok(!(M2_RUN_SOURCES.candidate as readonly string[]).includes(c));
  }
  assert.match(m2SourceSql("candidate"), /^SELECT JSON_OBJECT\(.*\) FROM `candidate`$/);
});

test("the input is the whole candidate table, counted before and after one read", async () => {
  const rows = [candidate(1, { candidate_resume: "a.pdf" }), candidate(2, { deleted: 1, candidate_resume: "a.pdf" }), candidate(3, { candidate_resume: "b.pdf" })];
  const { reader, queries } = mirror(rows, [3, 3]);
  const sources = await readM2Sources(reader);
  assert.equal(queries[0], M2_CANDIDATE_COUNT_SQL);
  assert.equal(queries.at(-1), M2_CANDIDATE_COUNT_SQL);
  const plan = planM2(sources, "2026-11-26");
  // The archived row still claims a.pdf, so person 1 is held.
  assert.deepEqual(plan.documents, [{ legacyId: "3", kind: "resume", keys: ["candidate-resume/b.pdf"] }]);
  assert.deepEqual(plan.issues, [{ rule: "document.sharedObject", legacyId: "1", field: "candidate_resume", target: "2" }]);
  assert.equal(plan.candidates, 3);
});

test("a truncated read, a changing table or an unreadable count is refused before any object is read", async () => {
  const rows = [candidate(1), candidate(2)];
  for (const counts of [[3, 3], [2, 3], [3, 2], [2], [Number.NaN, 2]]) {
    await assert.rejects(readM2Sources(mirror(rows, counts).reader), (e: unknown) => e instanceof M2InputError && e.code === "m2.ownershipIncomplete", JSON.stringify(counts));
  }
  const failing: LegacyReader = { async rows(sql) { if (sql === M2_CANDIDATE_COUNT_SQL) return [{ n: 0 }]; throw new Error("Secret detail"); } };
  await assert.rejects(readM2Sources(failing), (e: unknown) => e instanceof M2InputError && e.code === "m2.read.candidate" && !String(e).includes("Secret"));
});
