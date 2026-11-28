import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresStoreDocumentViewsStore, runMigrations } from "@studenthub/db";

// M-05 (migration 0411): store document views are recorded with the store that gave sight, and never edited.
const URL = process.env.DATABASE_URL ?? "";
const REF = "a".repeat(64);
let pool: pg.Pool, views: PostgresStoreDocumentViewsStore, authz: PostgresAuthzStore;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  views = new PostgresStoreDocumentViewsStore({ pool });
  authz = new PostgresAuthzStore(pool);
});
after(async () => pool.end());

async function person() {
  const id = `m5-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], displayName: `Person ${id}` }));
  return id;
}
async function store() {
  const orgId = `m5-org-${randomUUID()}`, id = randomUUID();
  await pool.query("INSERT INTO organizations (id, name, parent_org_id) VALUES ($1, 'Company', NULL)", [orgId]);
  await pool.query("INSERT INTO organization_stores (id, org_id, name, location, created_by_ref, updated_by_ref) VALUES ($1, $2, 'Avenues', 'Hall 2', $3, $3)", [id, orgId, REF]);
  return id;
}

test("STOREDOCDB_RECORD each issue and delivery is kept, newest first, and never edited", async () => {
  const [manager, subject, storeId] = [await person(), await person(), await store()];
  await views.recordView({ viewerPrincipalId: manager, subjectPrincipalId: subject, storeId, operation: "issue", documentType: "resume", documentVersion: "v1" });
  await views.recordView({ viewerPrincipalId: manager, subjectPrincipalId: subject, storeId, operation: "deliver", documentType: "resume", documentVersion: "v1" });
  const rows = await views.forSubject(subject);
  assert.deepEqual(rows.map((r) => [r.viewerPrincipalId, r.storeId, r.operation, r.documentType, r.documentVersion]),
    [[manager, storeId, "deliver", "resume", "v1"], [manager, storeId, "issue", "resume", "v1"]], "STOREDOCDB_RECORD both rows, newest first");
  await assert.rejects(pool.query("UPDATE store_document_views SET operation = 'issue' WHERE subject_principal_id = $1", [subject]), /append-only/, "STOREDOCDB_RECORD no update");
  await assert.rejects(pool.query("DELETE FROM store_document_views WHERE subject_principal_id = $1", [subject]), /append-only/, "STOREDOCDB_RECORD no delete");
});

test("STOREDOCDB_CHECKS civil ID images, unknown stores, people and operations are refused", async () => {
  const [manager, subject, storeId] = [await person(), await person(), await store()];
  const view = { viewerPrincipalId: manager, subjectPrincipalId: subject, storeId, operation: "issue" as const, documentType: "resume" as const, documentVersion: "v1" };
  await assert.rejects(views.recordView({ ...view, documentType: "civil-id-front" as never }), /check constraint/, "STOREDOCDB_CHECKS no civil ID image");
  await assert.rejects(views.recordView({ ...view, operation: "view" as never }), /check constraint/, "STOREDOCDB_CHECKS operations");
  await assert.rejects(views.recordView({ ...view, documentVersion: "" }), /check constraint/, "STOREDOCDB_CHECKS a version");
  await assert.rejects(views.recordView({ ...view, storeId: randomUUID() }), /foreign key/, "STOREDOCDB_CHECKS a real store");
  await assert.rejects(views.recordView({ ...view, subjectPrincipalId: "nobody" }), /foreign key/, "STOREDOCDB_CHECKS a real person");
  assert.deepEqual(await views.forSubject(subject), [], "STOREDOCDB_CHECKS nothing kept");
});
