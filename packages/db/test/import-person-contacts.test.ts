import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PersonContactImportError, PostgresPersonContactImportStore, isValidPersonContactRow, legacyCivilIdRef, normaliseVerifiedEmail, type PersonContactImportRow } from "@studenthub/db/import";
import { CivilIdVault } from "../../profile/src/index.js";
import { mapLegacyPersonContacts, normaliseEmail } from "../../../tools/legacy-import/src/m1-contact.js";
import { mapLegacyCandidates } from "../../../tools/legacy-import/src/m1-people.js";
import { fixtureIds } from "./legacy-fixture-ids.js";

// Synthetic rows only. Every phone, handle and civil ID is derived from a fresh fixture id, so
// runs can share a database without tripping the unique indexes.

const URL = process.env.DATABASE_URL ?? "";
const TODAY = "2026-11-25";
let pool: pg.Pool, store: PostgresPersonContactImportStore, vault: CivilIdVault;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  vault = new CivilIdVault(randomBytes(32));
  store = new PostgresPersonContactImportStore(pool, vault, randomBytes(32));
});
after(async () => { await pool.end(); });

/** Mapped through the real M-1 mappers, as the run will. */
const contacts = (rows: readonly Record<string, unknown>[]) => {
  const full = rows.map((r) => ({ deleted: 0, candidate_name: "Test Person", ...r }));
  const { people } = mapLegacyCandidates({ candidate: full, country: [], university: [], area: [] }, TODAY);
  return mapLegacyPersonContacts(full, people).contacts;
};
const kw = (id: number) => String(id); // fixture ids have 12 digits
const bh = (id: number) => String(id).slice(-9);
const read = async (id: number) => (await pool.query("SELECT * FROM legacy_candidate_contacts WHERE legacy_candidate_id = $1", [String(id)])).rows[0];

test("contacts stage once; a re-run is unchanged and a changed row is a conflict, never an overwrite", async () => {
  const a = await fixtureIds(pool), b = a + 1;
  const first = contacts([
    { candidate_id: a, candidate_phone: `+96${a}`, profile_url: `t${a}`, candidate_civil_id: kw(a), candidate_civil_need_verification: 1 },
    { candidate_id: b, profile_url: `t${b}` },
  ]);
  assert.deepEqual(await store.importContacts(first), { inserted: 2, unchanged: 0, conflicts: [], refused: [] });
  assert.deepEqual(await store.importContacts(first), { inserted: 0, unchanged: 2, conflicts: [], refused: [] });
  const changed = contacts([{ candidate_id: a, candidate_phone: `+97${a}`, profile_url: `t${a}`, candidate_civil_id: kw(a), candidate_civil_need_verification: 1 }]);
  const result = await store.importContacts(changed);
  assert.deepEqual(result, { inserted: 0, unchanged: 0, conflicts: [{ legacyId: String(a) }], refused: [] });
  assert.ok(!JSON.stringify(result).includes("+9"), "a result carries no phone");
  const row = await read(a);
  assert.equal(row.phone, `+96${a}`);
  assert.equal(row.civil_needs_review, true);
  assert.equal((await read(b)).civil_country, null);
  const rec = await store.reconcile([String(a), String(b), String(b + 1)], [String(b + 1)]);
  assert.deepEqual([rec.legacy, rec.imported, rec.skipped, rec.missing], [3, 2, [String(b + 1)], []]);
});

test("a civil ID is stored only sealed to its legacy candidate, with its keyed hash; the digest is keyed too", async () => {
  const a = await fixtureIds(pool), b = a + 1;
  await store.importContacts(contacts([
    { candidate_id: a, candidate_civil_id: kw(a) }, { candidate_id: b, candidate_civil_id: bh(b), candidate_civil_need_verification: 0 },
  ]));
  for (const [id, country, number] of [[a, "KW", kw(a)], [b, "BH", bh(b)]] as const) {
    const row = await read(id);
    assert.equal(row.civil_country, country);
    assert.ok(!row.civil_number_ciphertext.includes(Buffer.from(number)), "the full number is never in the ciphertext");
    assert.equal(vault.open(legacyCivilIdRef(String(id)), country, row.civil_number_ciphertext), number);
    assert.throws(() => vault.open("principal-x", country, row.civil_number_ciphertext), "bound to the legacy candidate");
    assert.deepEqual(row.civil_number_hash, vault.hash(country, number));
    // The id itself is excluded: these synthetic numbers are derived from it.
    const text = JSON.stringify({ ...row, legacy_candidate_id: null, civil_number_ciphertext: null, civil_number_hash: null });
    assert.ok(!text.includes(number));
    const plain = createHash("sha256").update(JSON.stringify(["m1-contact-v1", String(id), null, null, [country, number], row.civil_needs_review])).digest("hex");
    assert.notEqual(row.digest.trim(), plain);
  }
  assert.equal((await read(b)).civil_needs_review, false);
  // Another key gives another digest for the same row: nothing outside the key holder can recompute it.
  const other = new PostgresPersonContactImportStore(pool, vault, randomBytes(32));
  const [row] = contacts([{ candidate_id: a, candidate_civil_id: kw(a) }]);
  assert.notEqual(other.digest(row!), store.digest(row!));
  assert.deepEqual(await other.importContacts([row!]), { inserted: 0, unchanged: 0, conflicts: [{ legacyId: String(a) }], refused: [] });
});

test("rows off the contract are refused before any lookup, new or replayed, without values, and the batch goes on", async () => {
  const a = await fixtureIds(pool), b = a + 1, c = a + 2;
  const [held] = contacts([{ candidate_id: a, candidate_phone: `+96${a}` }]);
  await store.importContacts([held!]);
  const [fresh] = contacts([{ candidate_id: b, candidate_phone: `+96${b}`, candidate_civil_id: kw(b) }]);
  const [later] = contacts([{ candidate_id: c, profile_url: `t${c}` }]);
  const bad: unknown[] = [
    { ...held!, phone: "+96 not" },
    { ...held!, email: "x@example.invalid" },
    { ...fresh!, civilId: { country: "KW", number: bh(b) } },
    { ...fresh!, civilId: { country: "BH", number: bh(b), extra: 1 } },
    { ...fresh!, civilId: null, civilIdNeedsReview: true },
    { ...fresh!, phone: null, handle: null, civilId: null, civilIdNeedsReview: null, verifiedEmail: null },
    { ...fresh!, legacyId: `0${b}` },
    { ...fresh!, handle: "UPPER" },
    null,
  ];
  const result = await store.importContacts([...bad, later!] as never);
  assert.deepEqual(result, {
    inserted: 1, unchanged: 0, conflicts: [],
    refused: [
      { legacyId: String(a), code: "invalid" }, { legacyId: String(a), code: "invalid" },
      { legacyId: String(b), code: "invalid" }, { legacyId: String(b), code: "invalid" }, { legacyId: String(b), code: "invalid" },
      { legacyId: String(b), code: "invalid" }, { legacyId: "?", code: "invalid" }, { legacyId: String(b), code: "invalid" },
      { legacyId: "?", code: "invalid" },
    ],
  });
  assert.equal(await read(b), undefined);
  assert.equal((await read(a)).phone, `+96${a}`);
  assert.equal((await read(c)).profile_handle, `t${c}`);
});

test("a phone, handle or civil ID another staged candidate holds is refused as duplicate; the batch goes on", async () => {
  const a = await fixtureIds(pool), b = a + 1, c = a + 2, d = a + 3, e = a + 4;
  await store.importContacts(contacts([{ candidate_id: a, candidate_phone: `+96${a}`, profile_url: `t${a}`, candidate_civil_id: kw(a) }]));
  // Each later row clashes with a on one value only; the mapper never saw them together.
  const rows: PersonContactImportRow[] = [
    { legacyId: String(b), phone: `+96${a}`, handle: null, civilId: null, civilIdNeedsReview: null, verifiedEmail: null },
    { legacyId: String(c), phone: null, handle: `t${a}`, civilId: null, civilIdNeedsReview: null, verifiedEmail: null },
    { legacyId: String(d), phone: null, handle: null, civilId: { country: "KW", number: kw(a) }, civilIdNeedsReview: null, verifiedEmail: null },
    { legacyId: String(e), phone: `+96${e}`, handle: null, civilId: null, civilIdNeedsReview: null, verifiedEmail: null },
  ];
  assert.deepEqual(await store.importContacts(rows), {
    inserted: 1, unchanged: 0, conflicts: [],
    refused: [{ legacyId: String(b), code: "duplicate" }, { legacyId: String(c), code: "duplicate" }, { legacyId: String(d), code: "duplicate" }],
  });
});

test("an unexpected failure rolls the batch back and throws only a fixed error: no message detail, no cause", async () => {
  const a = await fixtureIds(pool), b = a + 1;
  const SENTINEL = `Zz${kw(b)}Secret`;
  const leaky = { keyVersion: 1, seal: () => { const e = new Error(`sealing ${SENTINEL} failed`) as Error & { detail?: string }; e.detail = SENTINEL; throw e; } };
  const failing = new PostgresPersonContactImportStore(pool, leaky, randomBytes(32));
  const rows = contacts([{ candidate_id: a, candidate_phone: `+96${a}` }, { candidate_id: b, candidate_civil_id: kw(b) }]);
  await assert.rejects(failing.importContacts(rows), (error: unknown) => {
    assert.ok(error instanceof PersonContactImportError);
    assert.equal(error.message, "m1.contact.importFailed");
    assert.equal(error.code, "m1.contact.importFailed");
    assert.equal((error as Error & { cause?: unknown }).cause, undefined);
    const shown = JSON.stringify({ ...error, message: error.message, stack: error.stack, string: String(error) });
    assert.ok(!shown.includes(SENTINEL) && !shown.includes(kw(b)) && !shown.includes(`+96${a}`), shown);
    return true;
  });
  assert.equal(await read(a), undefined, "the row before the failure rolled back with the batch");
  // A database that cannot be reached fails the same way.
  const nowhere = new PostgresPersonContactImportStore({ connectionString: URL.replace(/\/[^/?]+(\?|$)/, "/no_such_database$1") }, vault, randomBytes(32));
  try { await assert.rejects(nowhere.importContacts(rows), (e: unknown) => e instanceof PersonContactImportError && e.message === "m1.contact.importFailed"); }
  finally { await nowhere.close(); }
});

test("a legacy-verified address is staged only as its keyed HMAC; a shared one is refused as duplicate", async () => {
  const a = await fixtureIds(pool), b = a + 1, c = a + 2;
  const address = `m1-${a}@example.invalid`;
  const [row] = contacts([{ candidate_id: a, candidate_email: ` ${address.toUpperCase()}`, candidate_email_verification: 1 }]);
  assert.equal(row!.verifiedEmail, address);
  assert.deepEqual(await store.importContacts([row!]), { inserted: 1, unchanged: 0, conflicts: [], refused: [] });
  assert.deepEqual(await store.importContacts([row!]), { inserted: 0, unchanged: 1, conflicts: [], refused: [] });
  const staged = await read(a);
  assert.deepEqual(staged.verified_email_hmac, store.emailDigest(address), "the cutover compare hashes the current address the same way");
  assert.notDeepEqual(staged.verified_email_hmac, store.emailDigest(`x${address}`));
  assert.ok(!JSON.stringify({ ...staged, verified_email_hmac: null }).includes("example.invalid"), "no address is stored");
  assert.equal(staged.phone, null);
  const clash: PersonContactImportRow = { legacyId: String(b), phone: null, handle: null, civilId: null, civilIdNeedsReview: null, verifiedEmail: address };
  const bad = { ...clash, legacyId: String(c), verifiedEmail: "Mixed@Example.invalid" };
  assert.deepEqual(await store.importContacts([clash, bad as never]), {
    inserted: 0, unchanged: 0, conflicts: [], refused: [{ legacyId: String(b), code: "duplicate" }, { legacyId: String(c), code: "invalid" }],
  });
});

test("the table refuses a malformed id, value or half-recorded civil ID", async () => {
  const ins = (cols: string, vals: string) => pool.query(`INSERT INTO legacy_candidate_contacts (legacy_candidate_id, digest, ${cols}) VALUES ('5', '${"a".repeat(64)}', ${vals})`);
  await assert.rejects(pool.query(`INSERT INTO legacy_candidate_contacts (legacy_candidate_id, digest, phone) VALUES ('05', '${"a".repeat(64)}', '+96550001234')`), { code: "23514" });
  await assert.rejects(ins("phone", "'50001234'"), { code: "23514" });
  await assert.rejects(ins("profile_handle", "'Upper'"), { code: "23514" });
  await assert.rejects(ins("civil_country", "'KW'"), { code: "23514" });
  await assert.rejects(ins("civil_needs_review", "true"), { code: "23514" });
  await assert.rejects(ins("civil_country, civil_number_ciphertext, civil_number_hash, civil_key_version", `'SA', '\\x${"00".repeat(40)}', '\\x${"00".repeat(32)}', 1`), { code: "23514" });
  await assert.rejects(pool.query(`INSERT INTO legacy_candidate_contacts (legacy_candidate_id, digest) VALUES ('5', '${"a".repeat(64)}')`), { code: "23514" });
  await assert.rejects(ins("verified_email_hmac", `'\\x${"00".repeat(31)}'`), { code: "23514" });
});

test("the mapper and the cutover compare normalise an address the same, locale-invariant way", () => {
  const vectors = [" Kate@Example.INVALID ", "kate@example.invalid", "\u212Aate@example.invalid", "\u0130an@example.invalid",
    "a\u00e9@example.invalid", "\ta@b.c", "a@b@c", "IAN@EXAMPLE.INVALID", `${"a".repeat(250)}@b.c`, ""];
  for (const raw of vectors) assert.equal(normaliseVerifiedEmail(raw), normaliseEmail(raw), JSON.stringify(raw));
  assert.equal(normaliseVerifiedEmail("IAN@EXAMPLE.INVALID"), "ian@example.invalid", "no Turkish dotless i");
  assert.deepEqual(store.currentEmailDigest(" Kate@Example.INVALID "), store.emailDigest("kate@example.invalid"));
  assert.equal(store.currentEmailDigest("\u212Aate@example.invalid"), null, "a non-ASCII current address gets no verified fact");
  assert.throws(() => store.emailDigest("Kate@example.invalid"), TypeError);
  assert.throws(() => store.emailDigest("\u212Aate@example.invalid"), TypeError);
  const row: PersonContactImportRow = { legacyId: "1", phone: null, handle: null, civilId: null, civilIdNeedsReview: null, verifiedEmail: "\u212Aate@example.invalid" };
  assert.equal(isValidPersonContactRow(row), false);
});
