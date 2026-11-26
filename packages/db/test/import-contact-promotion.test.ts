import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { emailVerifiedSql } from "@studenthub/db";
import { ContactPromotionError, PostgresContactPromotion, PostgresPersonContactImportStore, normaliseVerifiedEmail } from "@studenthub/db/import";
import { CivilIdVault } from "../../profile/src/index.js";
import { mapLegacyPersonContacts } from "../../../tools/legacy-import/src/m1-contact.js";
import { mapLegacyCandidates } from "../../../tools/legacy-import/src/m1-people.js";
import { fixtureIds } from "./legacy-fixture-ids.js";

// Synthetic rows only. Every phone, handle, civil ID and address is derived from a fresh fixture
// id, so runs can share a database without tripping the unique indexes.

const URL = process.env.DATABASE_URL ?? "";
const TODAY = "2026-11-25";
const DIGEST_KEY = randomBytes(32);
let pool: pg.Pool, staging: PostgresPersonContactImportStore, promotion: PostgresContactPromotion, vault: CivilIdVault;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  vault = new CivilIdVault(randomBytes(32));
  staging = new PostgresPersonContactImportStore(pool, vault, DIGEST_KEY);
  promotion = new PostgresContactPromotion(pool, vault, DIGEST_KEY);
});
after(async () => { await pool.end(); });

/** Stages legacy candidates through the real M-1 mappers and the staging store, as the run will. */
const stage = async (rows: readonly Record<string, unknown>[], store = staging) => {
  const full = rows.map((r) => ({ deleted: 0, candidate_name: "Test Person", ...r }));
  const { people } = mapLegacyCandidates({ candidate: full, country: [], university: [], area: [] }, TODAY);
  const result = await store.importContacts(mapLegacyPersonContacts(full, people).contacts);
  assert.equal(result.inserted, rows.length);
};
const person = async (email: string | null) => {
  const id = `promo-${randomUUID()}`;
  await pool.query("INSERT INTO principals (id, display_name, email) VALUES ($1, 'Test Person', $2)", [id, email]);
  return id;
};
const link = async (principalId: string, legacyId: number) => {
  await pool.query("INSERT INTO legacy_account_links (principal_id, legacy_candidate_id, linked_by_ref, method) VALUES ($1, $2, $3, 'staff')",
    [principalId, String(legacyId), "a".repeat(64)]);
};
const profile = async (id: string) => (await pool.query("SELECT phone, phone_written_at, profile_handle, profile_handle_written_at FROM person_profiles WHERE principal_id = $1", [id])).rows[0];
const civil = async (id: string) => (await pool.query("SELECT country, number_ciphertext, number_hash, key_version, needs_review, revision, released_at FROM person_civil_ids WHERE principal_id = $1", [id])).rows[0];
const verification = async (id: string) => (await pool.query("SELECT email, verified, source FROM principal_email_verifications WHERE principal_id = $1", [id])).rows;
const full = (a: number, email: string) => ({
  candidate_id: a, candidate_phone: `+96${a}`, profile_url: `t${a}`, candidate_civil_id: String(a), candidate_civil_need_verification: 1,
  candidate_email: email, candidate_email_verification: 1,
});

test("a linked person gets the staged phone, handle, civil ID and verified address once; a re-run changes nothing", async () => {
  const a = await fixtureIds(pool);
  await stage([full(a, `p${a}@example.invalid`)]);
  const p = await person(`  P${a}@Example.invalid `);
  await link(p, a);
  assert.ok((await promotion.pending(10_000)).includes(p));

  const result = await promotion.promote(p);
  assert.deepEqual(result, { kind: "promoted", legacyId: String(a), outcomes: { phone: "promoted", handle: "promoted", civilId: "promoted", email: "promoted" } });
  assert.ok(!JSON.stringify(result).includes(`+96${a}`) && !JSON.stringify(result).includes("@"), "a result carries no value");

  const row = await profile(p);
  assert.equal(row.phone, `+96${a}`);
  assert.equal(row.profile_handle, `t${a}`);
  assert.ok(row.phone_written_at && row.profile_handle_written_at);
  const id = await civil(p);
  assert.equal(vault.open(p, "KW", id.number_ciphertext), String(a), "re-sealed to the principal");
  assert.ok(id.number_hash.equals(vault.hash("KW", String(a))));
  assert.throws(() => vault.open(`legacy-candidate:${a}`, "KW", id.number_ciphertext), "no longer bound to the legacy candidate");
  assert.deepEqual([id.needs_review, id.revision, id.released_at], [true, 1, null]);
  assert.deepEqual(await verification(p), [{ email: `p${a}@example.invalid`, verified: true, source: "legacy_import" }]);
  const record = (await pool.query("SELECT legacy_candidate_id, revision, phone, handle, civil_id, email FROM legacy_contact_promotions WHERE principal_id = $1", [p])).rows[0];
  assert.deepEqual(record, { legacy_candidate_id: String(a), revision: "contact-promotion-v1", phone: "promoted", handle: "promoted", civil_id: "promoted", email: "promoted" });

  // The person clears their phone; a re-run never brings it back.
  await pool.query("UPDATE person_profiles SET phone = NULL WHERE principal_id = $1", [p]);
  assert.deepEqual(await promotion.promote(p), { kind: "skipped", reason: "alreadyPromoted" });
  assert.equal((await profile(p)).phone, null);
  assert.ok(!(await promotion.pending(10_000)).includes(p));
});

test("anything the person wrote wins: a cleared field, a released civil ID and an OIDC answer are kept", async () => {
  const a = await fixtureIds(pool);
  await stage([full(a, `p${a}@example.invalid`)]);
  const p = await person(`p${a}@example.invalid`);
  await link(p, a);
  // A cleared phone is still written; the handle was never touched.
  await pool.query("INSERT INTO person_profiles (principal_id, phone, phone_written_at) VALUES ($1, NULL, now())", [p]);
  await pool.query("INSERT INTO person_civil_ids (principal_id, revision, released_at) VALUES ($1, 3, now())", [p]);
  await pool.query("INSERT INTO principal_email_verifications (principal_id, email, verified, source) VALUES ($1, $2, false, 'oidc')", [p, `p${a}@example.invalid`]);

  const result = await promotion.promote(p);
  assert.deepEqual(result, { kind: "promoted", legacyId: String(a), outcomes: { phone: "personWritten", handle: "promoted", civilId: "personWritten", email: "answered" } });
  const row = await profile(p);
  assert.deepEqual([row.phone, row.profile_handle], [null, `t${a}`]);
  const id = await civil(p);
  assert.deepEqual([id.country, id.revision], [null, 3]);
  assert.ok(id.released_at);
  assert.deepEqual(await verification(p), [{ email: `p${a}@example.invalid`, verified: false, source: "oidc" }]);
});

test("a value another person holds is left with them (taken), and the rest still promotes", async () => {
  const a = await fixtureIds(pool);
  await stage([full(a, `p${a}@example.invalid`)]);
  const holder = await person(null);
  await pool.query("INSERT INTO person_profiles (principal_id, phone, phone_written_at, profile_handle, profile_handle_written_at) VALUES ($1, $2, now(), $3, now())", [holder, `+96${a}`, `t${a}`]);
  const sealed = vault.seal(holder, "KW", String(a));
  await pool.query("INSERT INTO person_civil_ids (principal_id, country, number_ciphertext, number_hash, key_version, revision) VALUES ($1, 'KW', $2, $3, 1, 1)", [holder, sealed.ciphertext, sealed.hash]);
  const p = await person(`p${a}@example.invalid`);
  await link(p, a);

  assert.deepEqual(await promotion.promote(p), { kind: "promoted", legacyId: String(a), outcomes: { phone: "taken", handle: "taken", civilId: "taken", email: "promoted" } });
  assert.equal(await profile(p), undefined, "no empty profile row is left behind");
  assert.equal(await civil(p), undefined);
});

test("the address is verified only when the current address matches the staged one in the store's ASCII form", async () => {
  const a = await fixtureIds(pool), b = a + 1, c = a + 2;
  await stage([
    { candidate_id: a, profile_url: `t${a}`, candidate_email: `p${a}@example.invalid`, candidate_email_verification: 1 },
    { candidate_id: b, profile_url: `t${b}`, candidate_email: `p${b}@example.invalid`, candidate_email_verification: 1 },
    { candidate_id: c, profile_url: `t${c}`, candidate_email: `p${c}@example.invalid`, candidate_email_verification: 1 },
  ]);
  const changed = await person(`other${a}@example.invalid`), folded = await person(`p${b}@example.invalid`.replace("e", "K")), none = await person(null);
  await link(changed, a); await link(folded, b); await link(none, c);
  const outcome = async (id: string) => { const r = await promotion.promote(id); assert.equal(r.kind, "promoted"); return r.kind === "promoted" ? r.outcomes.email : null; };
  assert.equal(await outcome(changed), "mismatch");
  assert.equal(await outcome(folded), "unverifiable");
  assert.equal(await outcome(none), "unverifiable");
  for (const id of [changed, folded, none]) assert.deepEqual(await verification(id), []);
});

test("a civil ID that does not open under this key is recorded as undecryptable and nothing is written for it", async () => {
  const a = await fixtureIds(pool);
  await stage([{ candidate_id: a, profile_url: `t${a}`, candidate_civil_id: String(a) }], new PostgresPersonContactImportStore(pool, new CivilIdVault(randomBytes(32)), DIGEST_KEY));
  const p = await person(null);
  await link(p, a);
  const result = await promotion.promote(p);
  assert.deepEqual(result, { kind: "promoted", legacyId: String(a), outcomes: { phone: "none", handle: "promoted", civilId: "undecryptable", email: "none" } });
  assert.equal(await civil(p), undefined);
});

test("an unlinked or not-yet-staged person is skipped and nothing is recorded, so a later run retries", async () => {
  const a = await fixtureIds(pool);
  const unlinked = await person(null), unstaged = await person(null);
  await link(unstaged, a);
  assert.deepEqual(await promotion.promote(unlinked), { kind: "skipped", reason: "notLinked" });
  assert.deepEqual(await promotion.promote(unstaged), { kind: "skipped", reason: "notStaged" });
  assert.equal((await pool.query("SELECT 1 FROM legacy_contact_promotions WHERE principal_id = ANY($1)", [[unlinked, unstaged]])).rowCount, 0);
  await stage([{ candidate_id: a, profile_url: `t${a}` }]);
  assert.deepEqual(await promotion.promote(unstaged), { kind: "promoted", legacyId: String(a), outcomes: { phone: "none", handle: "promoted", civilId: "none", email: "none" } });
});

test("a database failure rolls the person back and throws only the fixed error", async () => {
  const a = await fixtureIds(pool);
  await stage([full(a, `p${a}@example.invalid`)]);
  const p = await person(`p${a}@example.invalid`);
  await link(p, a);
  // Names carry the fixture id, so runs sharing a database never collide.
  const fn = `promo_test_refuse_${a}`;
  await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'value %', NEW.legacy_candidate_id; END $$`);
  await pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON legacy_contact_promotions FOR EACH ROW WHEN (NEW.legacy_candidate_id = '${a}') EXECUTE FUNCTION ${fn}()`);
  try {
    await assert.rejects(promotion.promote(p), (e: unknown) => e instanceof ContactPromotionError && e.message === "m1.contact.promotionFailed" && e.cause === undefined);
    assert.equal(await profile(p), undefined);
    assert.equal(await civil(p), undefined);
    assert.deepEqual(await verification(p), []);
  } finally {
    await pool.query(`DROP TRIGGER ${fn} ON legacy_contact_promotions`);
    await pool.query(`DROP FUNCTION ${fn}()`);
  }
});

test("the address decision holds the principal row: an address change in flight is waited for and the new address is judged", async () => {
  const a = await fixtureIds(pool);
  await stage([{ candidate_id: a, profile_url: `t${a}`, candidate_email: `p${a}@example.invalid`, candidate_email_verification: 1 }]);
  const p = await person(`p${a}@example.invalid`);
  await link(p, a);
  const change = await pool.connect();
  try {
    await change.query("BEGIN");
    await change.query("UPDATE principals SET email = $2 WHERE id = $1", [p, `q${a}@example.invalid`]);
    const promoting = promotion.promote(p);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await change.query("COMMIT");
    const result = await promoting;
    assert.equal(result.kind === "promoted" && result.outcomes.email, "mismatch");
  } finally {
    change.release();
  }
  assert.deepEqual(await verification(p), []);
  await pool.query("UPDATE principals SET email = $2 WHERE id = $1", [p, `p${a}@example.invalid`]);
  assert.deepEqual(await verification(p), [], "changing back revives nothing");
});

test("a promoted fact never carries to a spelling outside the ASCII form, even one a locale would fold", async () => {
  // A fresh promoted principal per spelling, so each cleanup check starts from a verified fact.
  for (const spelling of [(a: number) => `\u212a${a}@example.invalid`, (a: number) => `k${a}@example.\u0130nvalid`, (a: number) => `k${a}@example.invalid\u00a0`]) {
    const a = await fixtureIds(pool);
    await stage([{ candidate_id: a, profile_url: `t${a}`, candidate_email: `k${a}@example.invalid`, candidate_email_verification: 1 }]);
    const p = await person(`K${a}@example.invalid`);
    await link(p, a);
    const result = await promotion.promote(p);
    assert.equal(result.kind === "promoted" && result.outcomes.email, "promoted");
    const verifiedNow = async () => (await pool.query(`SELECT ${emailVerifiedSql("$1::text")} AS v`, [p])).rows[0].v as boolean;
    assert.equal(await verifiedNow(), true, "verified before the change");
    assert.equal((await verification(p)).length, 1);
    const changed = spelling(a);
    await pool.query("UPDATE principals SET email = $2 WHERE id = $1", [p, changed]);
    assert.deepEqual(await verification(p), [], `the fact is dropped for ${JSON.stringify(changed)}`);
    assert.equal(await verifiedNow(), false);
    await assert.rejects(pool.query("INSERT INTO principal_email_verifications (principal_id, email, verified, source) VALUES ($1, $2, true, 'legacy_import')", [p, `k${a}@example.invalid`]), /current address/);
    await assert.rejects(pool.query("INSERT INTO principal_email_verifications (principal_id, email, verified, source) VALUES ($1, lower($2), true, 'legacy_import')", [p, changed]), /check constraint|current address/);
    await pool.query("UPDATE principals SET email = $2 WHERE id = $1", [p, `k${a}@example.invalid`]);
    assert.equal(await verifiedNow(), false, "changing back revives nothing");
  }
});

test("the database key and the importer's JavaScript rule agree on every spelling", async () => {
  const corpus = [
    "a@b.c", " A@B.C ", "MiXeD.Case+tag@Example.COM", "  spaced@x.y", "K@x.y", "İ@x.y", "ı@x.y", "straße@x.y",
    "a @x.y", "\ta@x.y", "a@x.y\t", "a b@x.y", "a@@x.y", "@x.y", "a@", "", "   ", "a@x.y".padStart(254, "z"), "a@x.y".padStart(255, "z"),
    "Ａ@x.y", "a@x.у", "a@x.y​", "A~!#$%&'*+/=?^_`{|}-@X.Y", "À@x.y",
  ];
  for (const raw of corpus) {
    const sql = (await pool.query<{ key: string | null }>("SELECT principal_email_key($1) AS key", [raw])).rows[0]!.key;
    assert.equal(sql, normaliseVerifiedEmail(raw), `same key for ${JSON.stringify(raw)}`);
  }
});
