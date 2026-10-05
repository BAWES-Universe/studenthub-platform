import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryProfileRecordStore, InMemoryReferenceResolver, ProfileRecordError, ProfileRecords,
  type ProfileRecordStore,
} from "../src/index.js";

// Shared fixture vocabulary: candidate P and candidate Q; synthetic catalogue ids only.
const P = "principal-candidate-p";
const Q = "principal-candidate-q";
const UNIVERSITY = "11111111-1111-4111-8111-111111111111";
const DEGREE = "22222222-2222-4222-8222-222222222222";
const DELETED_DEGREE = "33333333-3333-4333-8333-333333333333";
const MAJOR = "44444444-4444-4444-8444-444444444444";
const FIXED = new Date("2026-10-04T12:00:00.000Z");

function rig() {
  const store = new InMemoryProfileRecordStore();
  const references = new InMemoryReferenceResolver();
  references.set("university", UNIVERSITY);
  references.set("degree", DEGREE);
  references.set("degree", DELETED_DEGREE, "deleted");
  references.set("major", MAJOR);
  return { store, references, records: new ProfileRecords(store, references, () => FIXED) };
}

async function rejects(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ProfileRecordError, `expected ProfileRecordError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

async function snapshot(store: ProfileRecordStore, owner: string): Promise<string> {
  return JSON.stringify(await store.listAll(owner));
}

test("SHU144_CROSS_PERSON_NOT_FOUND another person's rows are invisible and unchangeable", async () => {
  const { store, records } = rig();
  const experience = await records.create(P, "experience", { title: "Barista", employer: "Synthetic Cafe", startYear: 2024 });
  const link = await records.create(P, "link", { title: "Portfolio", url: "https://example.invalid/p" });
  await records.remove(P, "link", link.id);
  const before = await snapshot(store, P);
  const auditBefore = store.auditLog.length;

  const q = await records.background(Q);
  assert.deepEqual([q.education, q.experience, q.skill, q.link, q.removed].map((rows) => rows.length), [0, 0, 0, 0, 0]);
  await rejects(records.update(Q, "experience", experience.id, { title: "Owner", employer: "Q Corp", startYear: 2020 }), "not_found", 404);
  await rejects(records.remove(Q, "experience", experience.id), "not_found", 404);
  await rejects(records.restore(Q, "link", link.id), "not_found", 404);
  // A row that does not exist answers exactly the same way: existence is not revealed.
  await rejects(records.remove(Q, "experience", "55555555-5555-4555-8555-555555555555"), "not_found", 404);

  assert.equal(await snapshot(store, P), before, "P's rows must be byte-identical after Q's attempts");
  assert.equal(store.auditLog.length, auditBefore, "refused attempts write no audit");
});

test("SHU144_RESTORE_AFTER_DELETE removal is a soft delete and restore brings the same values back", async () => {
  const { records } = rig();
  const created = await records.create(P, "education", {
    educationType: "standard", universityId: UNIVERSITY, degreeId: DEGREE, majorId: MAJOR, graduationYear: 2027, currentlyStudying: true,
  });
  const removed = await records.remove(P, "education", created.id);
  assert.equal(removed.status, "deleted");
  assert.equal(removed.deletedAt, FIXED.toISOString());
  const afterRemove = await records.background(P);
  assert.equal(afterRemove.education.length, 0);
  assert.deepEqual(afterRemove.removed.map((row) => row.id), [created.id]);

  const restored = await records.restore(P, "education", created.id);
  assert.equal(restored.status, "active");
  assert.equal(restored.deletedAt, undefined);
  assert.deepEqual(restored.fields, created.fields);
  assert.deepEqual((await records.background(P)).education.map((row) => row.id), [created.id]);
  await rejects(records.restore(P, "education", created.id), "not_found", 404);
});

test("SHU144_AUDIT_ATOMIC a failing audit write commits no mutation", async () => {
  const { store, records } = rig();
  const kept = await records.create(P, "skill", { name: "Customer service" });
  const before = await snapshot(store, P);
  const auditBefore = store.auditLog.length;

  store.failNextAudit = true;
  await assert.rejects(records.create(P, "skill", { name: "Arabic" }));
  store.failNextAudit = true;
  await assert.rejects(records.remove(P, "skill", kept.id));
  store.failNextAudit = true;
  await assert.rejects(records.replaceSkills(P, ["Excel", "Sales"]));

  assert.equal(await snapshot(store, P), before, "no mutation may survive a failed audit");
  assert.equal(store.auditLog.length, auditBefore);
});

test("SHU144_DELETED_REFERENCE a deleted catalogue entry cannot be newly chosen", async () => {
  const { records, references } = rig();
  await rejects(records.create(P, "education", { educationType: "standard", universityId: UNIVERSITY, degreeId: DELETED_DEGREE, currentlyStudying: false }), "invalid_degree", 400);
  await rejects(records.create(P, "education", { educationType: "standard", universityId: "66666666-6666-4666-8666-666666666666", currentlyStudying: false }), "invalid_university", 400);
  const created = await records.create(P, "education", { educationType: "standard", universityId: UNIVERSITY, degreeId: DEGREE, currentlyStudying: false });

  // The degree is later soft-deleted in the catalogue: the existing row keeps its historical reference.
  references.set("degree", DEGREE, "deleted");
  const updated = await records.update(P, "education", created.id, { educationType: "standard", universityId: UNIVERSITY, degreeId: DEGREE, graduationYear: 2025, currentlyStudying: false });
  assert.equal((updated.fields as { degreeId?: string }).degreeId, DEGREE);
  await rejects(records.create(P, "education", { educationType: "standard", universityId: UNIVERSITY, degreeId: DEGREE, currentlyStudying: false }), "invalid_degree", 400);
});

test("SHU144_SKILL_REPLACE replaces the whole list in one audited step, keeping old rows restorable", async () => {
  const { store, records } = rig();
  await records.create(P, "skill", { name: "Excel" });
  await records.create(P, "skill", { name: "Sales" });
  const replaced = await records.replaceSkills(P, ["Arabic", { name: "English" }]);
  assert.deepEqual(replaced.map((row) => (row.fields as { name: string }).name), ["Arabic", "English"]);
  const background = await records.background(P);
  assert.deepEqual(background.skill.map((row) => (row.fields as { name: string }).name), ["Arabic", "English"]);
  assert.equal(background.removed.length, 2);
  assert.deepEqual(store.auditLog.at(-1), { operation: "profile_record.replace", ownerId: P, kind: "skill", activeBefore: 2, activeAfter: 2 });
  await rejects(records.replaceSkills(P, []), "empty_skill_list", 400);
  await rejects(records.replaceSkills(P, ["Excel", "excel"]), "duplicate_skill", 409);
  await rejects(records.create(P, "skill", { name: "ARABIC" }), "duplicate_skill", 409);
});

test("SHU144_CLOSED_INPUT input outside the field set is refused", async () => {
  const { records } = rig();
  await rejects(records.create(P, "skill", { name: "Excel", ownerId: Q }), "invalid_profile_record", 400);
  await rejects(records.create(P, "link", { title: "x", url: "javascript:alert(1)" }), "invalid_link_url", 400);
  await rejects(records.create(P, "link", { title: "x", url: "https://user:pass@example.invalid/" }), "invalid_link_url", 400);
  await rejects(records.create(P, "experience", { title: "Cashier", employer: "Shop", startYear: 2025, endYear: 2024 }), "invalid_end_year", 400);
  await rejects(records.create(P, "education", { educationType: "custom_university", currentlyStudying: false }), "invalid_institution", 400);
  await rejects(records.create(P, "education", { educationType: "not_studying", institutionName: "X", currentlyStudying: false }), "invalid_institution", 400);
  await rejects(records.create(P, "education", { educationType: "standard", universityId: UNIVERSITY, majorId: MAJOR, customMajor: "Art", currentlyStudying: false }), "invalid_major", 400);
  await rejects(records.create(P, "certificate", {}), "not_found", 404);
  await rejects(records.create("", "skill", { name: "Excel" }), "unauthorized", 401);
});

test("SHU144_AUDIT_WHITELIST audit entries carry only kind and counts", async () => {
  const { store, records } = rig();
  const link = await records.create(P, "link", { title: "Private title", url: "https://example.invalid/secret" });
  await records.update(P, "link", link.id, { title: "Changed", url: "https://example.invalid/other" });
  await records.remove(P, "link", link.id);
  await records.restore(P, "link", link.id);
  assert.deepEqual(store.auditLog.map((entry) => entry.operation), ["profile_record.create", "profile_record.update", "profile_record.remove", "profile_record.restore"]);
  for (const entry of store.auditLog) {
    assert.deepEqual(Object.keys(entry).sort(), ["activeAfter", "activeBefore", "kind", "operation", "ownerId"]);
    assert.doesNotMatch(JSON.stringify(entry), /Private|Changed|example\.invalid/);
  }
});

test("SHU144_LIMIT one owner holds at most 50 active rows per kind", async () => {
  const { records } = rig();
  for (let i = 0; i < 50; i += 1) await records.create(P, "skill", { name: `Skill ${i}` });
  await rejects(records.create(P, "skill", { name: "One more" }), "profile_record_limit", 409);
  await records.create(Q, "skill", { name: "One more" });
});
