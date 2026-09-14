import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresCatalogueStore, runMigrations } from "@studenthub/db";
import { ReferenceCatalogue, CatalogueError, type CatalogueActor } from "@studenthub/reference-catalogue";

const DB_URL = process.env.DATABASE_URL ?? "";
const actor: CatalogueActor = { principalRef: "a".repeat(64), orgId: randomUUID(), role: "staff" };
const candidate: CatalogueActor = { principalRef: "b".repeat(64), orgId: randomUUID(), role: "candidate" };
let pool: pg.Pool;

before(async () => {
  if (!DB_URL) throw new Error("DATABASE_URL is required for PostgreSQL catalogue tests");
  pool = new pg.Pool({ connectionString: DB_URL });
  await runMigrations(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE catalogue_submissions, catalogue_items, organizations CASCADE");
  await pool.query("INSERT INTO organizations(id,name) VALUES ($1,'Synthetic catalogue test')", [actor.orgId]);
});
after(async () => { await pool.end(); });

function catalogue(store = new PostgresCatalogueStore(pool)) {
  return new ReferenceCatalogue(store, () => new Date("2026-09-14T13:00:00.000Z"));
}

test("PostgreSQL catalogue persists active and deleted records across store instances", async () => {
  const first = catalogue();
  const created = await first.create(actor, "university", { name: "Kuwait University", code: "KU" });
  await first.remove(actor, "university", created.id);
  const second = catalogue();
  assert.deepEqual((await second.list("university")).items, []);
  const historical = await second.resolveHistorical("university", created.id);
  assert.equal(historical?.status, "deleted");
  assert.equal(historical?.name, "Kuwait University");
  const replacement = await second.create(actor, "university", { name: "Kuwait University", code: "KU2" });
  assert.notEqual(replacement.id, created.id, "soft-deleted names may be reused without erasing historical ids");
});

test("PostgreSQL moderation is atomic and exactly one concurrent decision can settle a submission", async () => {
  const service = catalogue();
  const pending = await service.submit(candidate, "major", { name: "Computer Science" });
  assert.deepEqual((await service.list("major")).items, []);
  const settled = await Promise.allSettled([
    service.moderate(actor, pending.id, "approved"),
    service.moderate(actor, pending.id, "rejected"),
  ]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected" && result.reason instanceof CatalogueError
    && result.reason.code === "catalogue_submission_not_pending").length, 1);
  const queue = await service.submissions(actor, { status: "pending" });
  assert.equal(queue.items.length, 0);
  const approved = await service.submissions(actor, { status: "approved" });
  const rejected = await service.submissions(actor, { status: "rejected" });
  assert.equal(approved.items.length + rejected.items.length, 1);
  assert.equal((await service.list("major")).items.length, approved.items.length);
});

test("PostgreSQL keyset pagination remains stable when rows arrive between pages", async () => {
  const service = catalogue();
  await service.create(actor, "bank", { name: "Alpha Bank" });
  await service.create(actor, "bank", { name: "Charlie Bank" });
  const first = await service.list("bank", { pageSize: 1 });
  await service.create(actor, "bank", { name: "Bravo Bank" });
  const second = await service.list("bank", { pageSize: 1, cursor: first.nextCursor });
  const third = await service.list("bank", { pageSize: 1, cursor: second.nextCursor });
  assert.deepEqual([...first.items, ...second.items, ...third.items].map((item) => item.name),
    ["Alpha Bank", "Bravo Bank", "Charlie Bank"]);
});

test("PostgreSQL constraints reject duplicate active names and invalid actor provenance", async () => {
  const service = catalogue();
  await service.create(actor, "country", { name: "Kuwait" });
  await assert.rejects(() => service.create(actor, "country", { name: "  KUWAIT " }), (error: unknown) =>
    error instanceof CatalogueError && error.code === "catalogue_conflict");
  await assert.rejects(() => new ReferenceCatalogue(new PostgresCatalogueStore(pool)).create(
    { ...actor, principalRef: "raw-email@example.invalid" }, "country", { name: "Unsafe" }),
  (error: unknown) => error instanceof CatalogueError && error.code === "catalogue_conflict");
});
