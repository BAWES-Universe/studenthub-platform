import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";

const DB_URL = process.env.DATABASE_URL ?? "";
const OPERATOR = `shu323-operator-${randomUUID()}`;
let pool: pg.Pool;
let authz: PostgresAuthzStore;

before(async () => {
  if (!DB_URL) throw new Error("DATABASE_URL is required for PostgreSQL organization-notes append-only tests");
  pool = new pg.Pool({ connectionString: DB_URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: OPERATOR, name: "Synthetic SHU-323 operator" }));
});

after(async () => { await pool.end(); });

async function fixture() {
  const orgId = `shu323-noted-${randomUUID()}`;
  const emptyOrgId = `shu323-empty-${randomUUID()}`;
  const authorId = `shu323-author-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: orgId, name: "Synthetic noted organization", parentOrgId: OPERATOR }));
  await authz.upsertOrganization(createOrganization({ id: emptyOrgId, name: "Synthetic empty organization", parentOrgId: OPERATOR }));
  await pool.query("INSERT INTO principals (id) VALUES ($1)", [authorId]);
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO organization_notes (org_id, author_principal_id, body, receipt_ref)
     VALUES ($1, $2, 'original', $3) RETURNING id::text`,
    [orgId, authorId, randomBytes(32).toString("hex")],
  );
  return { orgId, emptyOrgId, noteId: inserted.rows[0]!.id };
}

function appendOnly(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "55000"
    && /append-only/.test(error.message);
}

test("SHU-323/AC-01 delete-refused refuses note deletes and preserves the note", async () => {
  const { orgId, noteId } = await fixture();
  await assert.rejects(pool.query("DELETE FROM organization_notes WHERE id=$1", [noteId]), appendOnly);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM organization_notes WHERE id=$1", [noteId])).rows[0].count, 1);
  await assert.rejects(pool.query("DELETE FROM organization_notes WHERE org_id=$1", [orgId]), appendOnly);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM organization_notes WHERE id=$1", [noteId])).rows[0].count, 1);
  const trigger = await pool.query<{ tgtype: number }>(
    "SELECT tgtype FROM pg_trigger WHERE tgrelid='organization_notes'::regclass AND tgname='organization_notes_no_update' AND NOT tgisinternal",
  );
  assert.equal(trigger.rows.length, 1);
  assert.notEqual(trigger.rows[0]!.tgtype & 8, 0, "row trigger must fire on DELETE");
  assert.notEqual(trigger.rows[0]!.tgtype & 16, 0, "row trigger must still fire on UPDATE");
});

async function refusedTruncate(sql: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(client.query(sql), appendOnly);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

test("SHU-323/AC-02 truncate-refused refuses direct and cascaded truncation", async () => {
  await fixture();
  await refusedTruncate("TRUNCATE organization_notes");
  await refusedTruncate("TRUNCATE organizations CASCADE");
  const trigger = await pool.query<{ tgtype: number }>(
    "SELECT tgtype FROM pg_trigger WHERE tgrelid='organization_notes'::regclass AND tgname='organization_notes_no_truncate' AND NOT tgisinternal",
  );
  assert.equal(trigger.rows.length, 1);
  assert.notEqual(trigger.rows[0]!.tgtype & 32, 0, "statement trigger must fire on TRUNCATE");
});

test("SHU-323/AC-03 noted-organization-delete-refused refuses cascade and permits an empty organization delete", async () => {
  const { orgId, emptyOrgId, noteId } = await fixture();
  await assert.rejects(pool.query("DELETE FROM organizations WHERE id=$1", [orgId]), appendOnly);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM organizations WHERE id=$1", [orgId])).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM organization_notes WHERE id=$1", [noteId])).rows[0].count, 1);
  assert.equal((await pool.query("DELETE FROM organizations WHERE id=$1", [emptyOrgId])).rowCount, 1);
});

test("SHU-323/AC-04 update-still-refused preserves the existing update rule", async () => {
  const { noteId } = await fixture();
  await assert.rejects(pool.query("UPDATE organization_notes SET body='changed' WHERE id=$1", [noteId]), appendOnly);
  assert.equal((await pool.query("SELECT body FROM organization_notes WHERE id=$1", [noteId])).rows[0].body, "original");
});
