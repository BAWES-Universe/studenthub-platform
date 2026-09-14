import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { InMemoryCatalogueStore, ReferenceCatalogue, CatalogueError } from "@studenthub/reference-catalogue";
import type { CatalogueActor } from "@studenthub/reference-catalogue";

const staff: CatalogueActor = { principalRef: "a".repeat(64), orgId: randomUUID(), role: "staff" };
const admin: CatalogueActor = { principalRef: "b".repeat(64), orgId: randomUUID(), role: "admin" };
const candidate: CatalogueActor = { principalRef: "c".repeat(64), orgId: randomUUID(), role: "candidate" };
const recruiter: CatalogueActor = { principalRef: "d".repeat(64), orgId: randomUUID(), role: "recruiter" };

function service(now = "2026-09-14T12:00:00.000Z") {
  return new ReferenceCatalogue(new InMemoryCatalogueStore(), () => new Date(now));
}

test("SHU166_PENDING_NOT_LISTED candidate university and major submissions remain hidden until staff approval", async () => {
  const catalogue = service();
  const university = await catalogue.submit(candidate, "university", { name: "Kuwait University", code: "KU" });
  const major = await catalogue.submit(candidate, "major", { name: "Computer Science" });
  assert.equal(university.status, "pending");
  assert.equal(major.status, "pending");
  assert.deepEqual((await catalogue.list("university")).items, [], "SHU166_PENDING_NOT_LISTED pending submission must not enter public list");
  const approved = await catalogue.moderate(staff, university.id, "approved");
  assert.equal(approved.status, "approved");
  assert.deepEqual((await catalogue.list("university")).items.map(({ name }) => name), ["Kuwait University"]);
  await assert.rejects(() => catalogue.moderate(admin, university.id, "approved"), (error: unknown) =>
    error instanceof CatalogueError && error.code === "catalogue_submission_not_pending");
});

test("SHU166_RECRUITER_WRITE existing roles permit staff/admin CRUD and refuse recruiter or candidate privilege escalation", async () => {
  const catalogue = service();
  await assert.rejects(() => catalogue.create(recruiter, "bank", { name: "Bank" }), (error: unknown) =>
    error instanceof CatalogueError && error.code === "catalogue_write_forbidden", "SHU166_RECRUITER_WRITE recruiter cannot create catalogue item");
  await assert.rejects(() => catalogue.create(candidate, "bank", { name: "Bank" }), CatalogueError);
  await assert.rejects(() => catalogue.submit(staff, "university", { name: "University" }), CatalogueError);
  await assert.rejects(() => catalogue.submit(candidate, "bank", { name: "Bank" }), (error: unknown) =>
    error instanceof CatalogueError && error.code === "catalogue_type_not_submittable");
  const item = await catalogue.create(staff, "bank", { name: "First Bank", code: "FB" });
  assert.equal((await catalogue.update(admin, "bank", item.id, { name: "First Bank Kuwait", code: "FBK" })).code, "FBK");
  assert.equal((await catalogue.remove(staff, "bank", item.id)).status, "deleted");
});

test("SHU166_HISTORICAL_RESOLVE soft deletion removes public discovery while retaining historical resolution", async () => {
  const catalogue = service();
  const item = await catalogue.create(admin, "major", { name: "Accounting" });
  const removed = await catalogue.remove(admin, "major", item.id);
  assert.equal(removed.status, "deleted");
  assert.deepEqual((await catalogue.list("major")).items, []);
  assert.deepEqual(await catalogue.resolveHistorical("major", item.id), removed,
    "SHU166_HISTORICAL_RESOLVE deleted catalogue id remains resolvable for old records");
  await assert.rejects(() => catalogue.update(admin, "major", item.id, { name: "Changed" }), CatalogueError);
});

test("SHU166_STABLE_PAGE keyset pagination is deterministic across inserts and ties", async () => {
  const catalogue = service();
  await catalogue.create(staff, "university", { name: "Alpha University" });
  await catalogue.create(staff, "university", { name: "Charlie University" });
  const first = await catalogue.list("university", { pageSize: 1 });
  assert.deepEqual(first.items.map((item) => item.name), ["Alpha University"]);
  assert.ok(first.nextCursor);
  await catalogue.create(staff, "university", { name: "Bravo University" });
  const second = await catalogue.list("university", { pageSize: 1, cursor: first.nextCursor });
  const third = await catalogue.list("university", { pageSize: 1, cursor: second.nextCursor });
  assert.deepEqual([...first.items, ...second.items, ...third.items].map((item) => item.name),
    ["Alpha University", "Bravo University", "Charlie University"], "SHU166_STABLE_PAGE no duplicate or skipped row");
  await assert.rejects(() => catalogue.list("major", { cursor: first.nextCursor }), (error: unknown) =>
    error instanceof CatalogueError && error.code === "invalid_cursor");
});

test("closed input rejects extra fields, unsafe text, bad codes, bad ids and duplicate active names", async () => {
  const catalogue = service();
  await assert.rejects(() => catalogue.create(admin, "tag", { name: "Safe", hidden: true }), CatalogueError);
  await assert.rejects(() => catalogue.create(admin, "tag", { name: "unsafe\u0000" }), CatalogueError);
  await assert.rejects(() => catalogue.create(admin, "tag", { name: "Safe", code: "spaces not allowed" }), CatalogueError);
  await catalogue.create(admin, "tag", { name: "  Graduate   role " });
  await assert.rejects(() => catalogue.create(admin, "tag", { name: "graduate role" }), (error: unknown) =>
    error instanceof CatalogueError && error.code === "catalogue_conflict");
  await assert.rejects(() => catalogue.remove(admin, "tag", "not-an-id"), (error: unknown) =>
    error instanceof CatalogueError && error.code === "invalid_catalogue_id");
});
