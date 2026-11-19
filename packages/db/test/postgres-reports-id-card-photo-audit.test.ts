import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, viewer: string, subject: string;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  const authz = new PostgresAuthzStore(pool);
  viewer = `idcp-staff-${randomUUID()}`; subject = `idcp-person-${randomUUID()}`;
  for (const id of [viewer, subject]) await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
});
after(async () => pool.end());

const view = (kind: string, type: string | null, version: string | null, who = viewer) => pool.query(
  "INSERT INTO staff_person_views(viewer_principal_id,subject_principal_id,kind,document_type,document_version) VALUES($1,$2,$3,$4,$5::uuid)", [who, subject, kind, type, version]);

test("REPORTS_ID_CARD_PHOTO_AUDIT printing a card records the photo read as id_card_render, for staff or the person themselves", async () => {
  const version = randomUUID();
  await view("id_card_render", "personal-photo", version);
  await view("id_card_render", "personal-photo", version, subject);
  const rows = await pool.query<{ viewer_principal_id: string; kind: string; document_type: string }>("SELECT viewer_principal_id, kind, document_type FROM staff_person_views WHERE subject_principal_id=$1 ORDER BY id", [subject]);
  assert.deepEqual(rows.rows.map(r => [r.viewer_principal_id, r.kind, r.document_type]), [[viewer, "id_card_render", "personal-photo"], [subject, "id_card_render", "personal-photo"]]);
});

test("REPORTS_ID_CARD_PHOTO_AUDIT an id_card_render row is always the personal photo with its version; existing kinds keep their rules", async () => {
  for (const [kind, type, version] of [["id_card_render", "resume", randomUUID()], ["id_card_render", "civil-id-front", randomUUID()], ["id_card_render", "personal-photo", null], ["id_card_render", null, null], ["id_card_render", null, randomUUID()], ["card_print", "personal-photo", randomUUID()]] as const)
    await assert.rejects(view(kind, type, version), /check constraint/, `${kind} ${type} ${version}`);
  await view("person_document_issue", "resume", randomUUID());
  await view("person_page", null, null);
  await assert.rejects(view("person_page", "personal-photo", randomUUID()), /check constraint/);
  await assert.rejects(pool.query("UPDATE staff_person_views SET kind='id_card_render' WHERE subject_principal_id=$1", [subject]), /append-only/);
});
