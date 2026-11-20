import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresIdCardsStore } from "@studenthub/db/reports";
import { FileDocumentStore } from "../../../packages/private-documents/src/index.js";
import { cleanJpeg } from "../../../packages/reports/src/index.js";
import { JPEG_WITH_GPS } from "../../../packages/reports/test/jpeg-fixtures.js";
import type { IncomingMessage } from "node:http";
import { wireStaffMessages } from "../../../apps/gateway/src/comms/wiring.js";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, viewer: string, subject: string;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
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

test("REPORTS_ID_CARD_PHOTO_WIRED the production wiring prints the person's own card with their photo and writes exactly one id_card_render row", async () => {
  // A person with an assignment and an issued card, and a photo in synthetic document storage, wired exactly as login-runtime wires it.
  const person = `idcp-wired-${randomUUID()}`, company = `idcp-co-${randomUUID()}`, store = randomUUID(), creator = `idcp-creator-${randomUUID()}`;
  for (const id of [person, creator]) await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  await authz.upsertOrganization(createOrganization({ id: company, name: "Photo Co" }));
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Avenues',$3,$3)", [store, company, "a".repeat(64)]);
  await pool.query(`INSERT INTO work_assignments(id,person_principal_id,org_id,store_id,contract_resolution,start_date,end_date,source,created_by) VALUES($1,$2,$3,$4,'{}','2020-01-01',NULL,'staff',$5)`, [randomUUID(), person, company, store, creator]);
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  assert.deepEqual(await new PostgresIdCardsStore({ pool }).write("issue", [person], today, "2099-01-01", creator), []);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 17, 8, 0x00, 0x20, 0x00, 0x30, 3, ...Array(9).fill(0x11), 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  const version = randomUUID(), root = await mkdtemp(join(tmpdir(), "idcp-wired-")), path = join(root, "store");
  const wired = wireStaffMessages({ connectionString: URL, authzStore: authz, env: { DOCUMENT_STORAGE: "synthetic-file", DOCUMENT_ORG_ID: "org", DOCUMENT_ROOT: path } });
  const audits = async () => (await pool.query<{ viewer_principal_id: string; document_type: string; document_version: string }>("SELECT viewer_principal_id, document_type, document_version::text FROM staff_person_views WHERE subject_principal_id=$1 AND kind='id_card_render' ORDER BY id", [person])).rows;
  try {
    // Storage not there yet: the card still prints, without the photo, and the failed open is not remembered.
    assert.doesNotMatch((await wired.http.idCards!.ownPdf(person))!.toString("latin1"), /\/Subtype \/Image/);
    assert.equal((await audits()).length, 0);
    const documents = await FileDocumentStore.create(path);
    await documents.transaction(async s => { s.documents.push({ id: randomUUID(), version, type: "personal-photo", mime: "image/jpeg", size: jpeg.length, scope: { orgId: "org", personId: person }, acl: "private", data: jpeg.toString("base64") } as (typeof s.documents)[number]); });
    const pdf = await wired.http.idCards!.ownPdf(person);
    assert.match(pdf!.toString("latin1"), /\/Subtype \/Image/, "the photo is on the card");
    assert.deepEqual(await audits(), [{ viewer_principal_id: person, document_type: "personal-photo", document_version: version }]);
    // Someone who is not staff cannot print the person's card: no photo read, no audit row.
    assert.deepEqual(await wired.http.idCards!.staffPdf(creator, [person]), { status: "not_found" });
    assert.equal((await audits()).length, 1);
  } finally { await wired.close(); await rm(root, { recursive: true, force: true }); }
});

/** A person with an assignment and an issued card, as the wired tests need. */
async function cardHolder(prefix: string): Promise<{ person: string; cardNumber: number }> {
  const person = `${prefix}-${randomUUID()}`, company = `${prefix}-co-${randomUUID()}`, store = randomUUID(), creator = `${prefix}-creator-${randomUUID()}`;
  for (const id of [person, creator]) await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  await authz.upsertOrganization(createOrganization({ id: company, name: "Photo Co" }));
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Avenues',$3,$3)", [store, company, "a".repeat(64)]);
  await pool.query(`INSERT INTO work_assignments(id,person_principal_id,org_id,store_id,contract_resolution,start_date,end_date,source,created_by) VALUES($1,$2,$3,$4,'{}','2020-01-01',NULL,'staff',$5)`, [randomUUID(), person, company, store, creator]);
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10), cards = new PostgresIdCardsStore({ pool });
  assert.deepEqual(await cards.write("issue", [person], today, "2099-01-01", creator), []);
  return { person, cardNumber: (await cards.card(person, today))!.cardNumber };
}

test("REPORTS_ID_CARD_PUBLIC_PHOTO_WIRED the production wiring serves a valid card's photo without EXIF and records exactly one public view with a hashed address", async () => {
  const { person, cardNumber } = await cardHolder("idcpub");
  const key = Buffer.alloc(32, 6), version = randomUUID(), root = await mkdtemp(join(tmpdir(), "idcpub-")), path = join(root, "store");
  const documents = await FileDocumentStore.create(path), photo = JPEG_WITH_GPS.rgb;
  await documents.transaction(async s => { s.documents.push({ id: randomUUID(), version, type: "personal-photo", mime: "image/jpeg", size: photo.length, scope: { orgId: "org", personId: person }, acl: "private", data: photo.toString("base64") } as (typeof s.documents)[number]); });
  const env = { DOCUMENT_STORAGE: "synthetic-file", DOCUMENT_ORG_ID: "org", DOCUMENT_ROOT: path, GATEWAY_TRUSTED_PROXIES: "127.0.0.1", ID_CARD_VERIFY_KEY: key.toString("base64") };
  const wired = wireStaffMessages({ connectionString: URL, authzStore: authz, env, idCardVerifyKey: key });
  const views = async () => (await pool.query<{ card_number: string; document_version: string; client_hash: string }>("SELECT card_number::text, document_version::text, client_hash FROM id_card_public_views WHERE subject_principal_id=$1 ORDER BY id", [person])).rows;
  const cards = wired.http.idCards!, req = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "198.51.100.77" } } as unknown as IncomingMessage;
  try {
    const { IdCardVerifier } = await import("../../../packages/reports/src/index.js");
    const token = new IdCardVerifier(key).token(cardNumber, "2099-01-01"), checked = await cards.check!(token);
    assert.equal(checked.status, "checked");
    const photoKey = checked.status === "checked" ? checked.photoKey! : "", client = cards.publicLimit!.client(req);
    assert.equal(await cards.publicPhoto!(token, "1.AAAAAAAAAAAAAAAAAAAAAA", client), null, "a bad key reads nothing");
    assert.deepEqual(await views(), []);
    const served = await cards.publicPhoto!(token, photoKey, client);
    assert.ok(served!.bytes.equals(cleanJpeg(photo)!), "the rebuilt JPEG");
    assert.ok(!served!.bytes.includes("SECRETPLACE"), "no GPS");
    const rows = await views();
    assert.deepEqual(rows, [{ card_number: String(cardNumber), document_version: version, client_hash: client }]);
    assert.match(client, /^[A-Za-z0-9_-]{22}$/); assert.ok(!client.includes("198.51.100.77"));
    const again = wireStaffMessages({ connectionString: URL, authzStore: authz, env, idCardVerifyKey: key });
    try { assert.equal(again.http.idCards!.publicLimit!.client(req), client, "the same hash from another gateway process"); } finally { await again.close(); }
    assert.equal((await pool.query("SELECT 1 FROM staff_person_views WHERE subject_principal_id=$1", [person])).rowCount, 0, "a public view is not a staff view");
  } finally { await wired.close(); await rm(root, { recursive: true, force: true }); }
});

test("REPORTS_ID_CARD_PUBLIC_VIEWS rows are never changed, removed or truncated, and hold only a hashed address", async () => {
  const { person, cardNumber } = await cardHolder("idcpv");
  const store = new PostgresIdCardsStore({ pool }), hash = "h".repeat(22);
  await store.recordPublicPhotoView({ cardNumber, subjectPrincipalId: person, documentVersion: randomUUID(), clientHash: hash });
  await assert.rejects(store.recordPublicPhotoView({ cardNumber, subjectPrincipalId: person, documentVersion: randomUUID(), clientHash: "198.51.100.77" }), /check constraint/, "a raw address is refused");
  await assert.rejects(store.recordPublicPhotoView({ cardNumber: cardNumber + 1_000_000, subjectPrincipalId: person, documentVersion: randomUUID(), clientHash: hash }), /foreign key/);
  await assert.rejects(pool.query("UPDATE id_card_public_views SET client_hash=$2 WHERE card_number=$1", [cardNumber, "x".repeat(22)]), /append-only/);
  await assert.rejects(pool.query("DELETE FROM id_card_public_views WHERE card_number=$1", [cardNumber]), /append-only/);
  await assert.rejects(pool.query("TRUNCATE id_card_public_views"), /append-only/);
  assert.equal((await pool.query("SELECT 1 FROM id_card_public_views WHERE card_number=$1", [cardNumber])).rowCount, 1);
});
