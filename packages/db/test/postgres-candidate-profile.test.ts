import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import {
  buildSelfEditWrite, candidateProfileRecordRef, normalizeIntro, normalizePersonName, normalizeSelfEdit,
  selfEditValueCheck, SELF_EDIT_FIELDS, type SelfEditField,
} from "@studenthub/profile";
import {
  CANDIDATE_PROFILE_OPERATION, principalAuditRef, PostgresAuthzStore, PostgresCandidateProfileStore, runMigrations,
} from "@studenthub/db";

// Synthetic fixtures only: made-up people, a made-up country and university.
const DB_URL = process.env.DATABASE_URL ?? "";
const KEY = "shu143-candidate-profile-test-secret-at-least-32-bytes";
const ORG = `shu143-profile-${randomUUID()}`;
const TODAY = "2026-10-08";
const FIXED = new Date("2026-10-08T12:00:00.000Z");
let pool: pg.Pool;
let authz: PostgresAuthzStore;
let store: PostgresCandidateProfileStore;
let country: string;
let university: string;

before(async () => {
  if (!DB_URL) throw new Error("DATABASE_URL is required for PostgreSQL candidate-profile tests");
  pool = new pg.Pool({ connectionString: DB_URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: ORG, name: "SHU-143 synthetic candidate-profile org" }));
  store = new PostgresCandidateProfileStore({ pool });
  country = await catalogueItem("country");
  university = await catalogueItem("university");
});
after(async () => { await pool.end(); });

async function catalogueItem(type: string, status: "active" | "deleted" = "active"): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO catalogue_items (id, catalogue_type, name, normalized_name, status, created_by_ref, updated_by_ref, created_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $3, $4, $5, $5, $6, $6, $7)`,
    [id, type, `Synthetic ${type} ${id.slice(0, 8)}`, status, "a".repeat(64), FIXED, status === "deleted" ? FIXED : null],
  );
  return id;
}

async function person(role = "candidate", email: string | undefined = undefined): Promise<string> {
  const id = `shu143-profile-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], ...(email === undefined ? {} : { email }) }));
  await authz.grantMany(id, [{ orgId: ORG, role: role as "candidate" }]);
  return id;
}

function rig(id: string) {
  const writer = buildSelfEditWrite({
    store: store.forPrincipal(id), secret: KEY,
    check: selfEditValueCheck(store.referencesFor(id), { today: () => TODAY }),
  });
  const principalRef = principalAuditRef(id);
  const change = (field: SelfEditField, value: string) => ({ personRef: candidateProfileRecordRef(id), field, value });
  async function write(field: SelfEditField, value: string) {
    const preview = await writer.preview({ principalRef, change: change(field, value) });
    assert.ok(preview.ok, `${field}: ${JSON.stringify(preview)}`);
    return writer.confirm({ principalRef, change: change(field, value), token: preview.token });
  }
  return { writer, change, principalRef, write };
}

/** A commit straight to the store, as a confirm racing another writer would reach it. */
function directCommit(id: string, field: SelfEditField, expectedBefore: string | null, value: string, options: {
  tokenId?: string; receiptRef?: string; personRef?: string; principalRef?: string; as?: string;
} = {}) {
  const principalRef = options.principalRef ?? principalAuditRef(id);
  const personRef = options.personRef ?? candidateProfileRecordRef(id);
  return Promise.resolve(store.forPrincipal(options.as ?? id).commit({
    personRef, principalRef, tokenId: options.tokenId ?? randomUUID(), field, expectedBefore, value,
    changeSetDigest: "b".repeat(64),
    receipt: { contractVersion: "3.0.0", receiptRef: options.receiptRef ?? randomUUID().replaceAll("-", "").padEnd(64, "0"),
      personRef, principalRef, changeSetDigest: "b".repeat(64), fields: [field], committedAt: FIXED.toISOString() },
  }));
}

/** A thrown database error, as a value an assertion can compare. */
const failed = (error: { code?: string }) => ({ threw: error.code });

async function row(id: string): Promise<string> {
  const { rows } = await pool.query("SELECT to_jsonb(p) AS row FROM candidate_profiles p WHERE principal_id = $1", [id]);
  return JSON.stringify(rows[0]?.row ?? null);
}

async function audits(id: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM authorization_mutation_audit WHERE operation = $1 AND target_principal_ref = $2",
    [CANDIDATE_PROFILE_OPERATION, principalAuditRef(id)]);
  return rows[0]!.n;
}

const VALUES = (): Record<SelfEditField, string> => ({
  display_name: "Synthetic Person", arabic_name: "شخص تجريبي", gender: "female", birth_date: "2006-03-14",
  nationality: country, kuwaiti_mother: "false", university, objective: "Retail and events", intro: "First line\n\nSecond line",
  preferred_time: "Evenings", profile_url: `synthetic-${randomUUID().slice(0, 8)}`, driving_licence: "true",
  job_search_status: "open_to_offers", phone: `+9655${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
});

test("SHU143_PG_WRITE every field round-trips through preview and confirm with a field-only, self-authored receipt", async () => {
  const id = await person("candidate", `${randomUUID()}@example.invalid`);
  const x = rig(id);
  const values = VALUES();
  for (const field of SELF_EDIT_FIELDS) {
    const done = await x.write(field, values[field]);
    assert.ok(done.ok, `${field}: ${JSON.stringify(done)}`);
    assert.deepEqual(done.receipt.fields, [field]);
    assert.equal(await store.forPrincipal(id).readField(candidateProfileRecordRef(id), field), values[field], field);
    const receipt = await store.readReceipt(id, done.receipt.receiptRef);
    assert.deepEqual(receipt, done.receipt);
    assert.equal(await store.readReceipt(await person(), done.receipt.receiptRef).catch(() => "threw"), null, "another person reads no receipt");
  }
  const { rows } = await pool.query<{ before_summary: unknown; after_summary: unknown; actor_principal_ref: string }>(
    "SELECT before_summary, after_summary, actor_principal_ref FROM authorization_mutation_audit WHERE operation = $1 AND target_principal_ref = $2",
    [CANDIDATE_PROFILE_OPERATION, principalAuditRef(id)]);
  assert.equal(rows.length, SELF_EDIT_FIELDS.length);
  const ledger = JSON.stringify(rows);
  for (const value of Object.values(values).filter((v) => v !== "true" && v !== "false")) {
    assert.ok(!ledger.includes(value), `the ledger carries ${value}`);
  }
  assert.ok(rows.every((r) => r.actor_principal_ref === principalAuditRef(id)));
  const stamp = await pool.query("SELECT job_search_updated_at IS NOT NULL AS stamped FROM candidate_profiles WHERE principal_id = $1", [id]);
  assert.equal(stamp.rows[0].stamped, true, "a job-search change records when it changed");
});

test("SHU143_PG_COMPLETENESS completeness is recomputed from the row on every write", async () => {
  const id = await person("candidate", `${randomUUID()}@example.invalid`);
  const x = rig(id);
  assert.ok((await x.write("display_name", "Synthetic Person")).ok);
  const first = await store.readPending(id);
  assert.ok(first?.includes("arabic_name") && first.includes("education") && !first.includes("display_name") && !first.includes("email"));
  // A child-table change shows up at the next self-edit.
  await pool.query(
    `INSERT INTO candidate_profile_records (id, owner_principal_id, kind, status, fields, created_at, updated_at)
     VALUES ($1, $2, 'skill', 'active', '{"skill":"Synthetic skill"}'::jsonb, $3, $3)`, [randomUUID(), id, FIXED]);
  assert.ok((await x.write("arabic_name", "شخص تجريبي")).ok);
  const second = await store.readPending(id);
  assert.ok(second && !second.includes("arabic_name") && !second.includes("skill") && second.includes("education"), JSON.stringify(second));
  // Requirements the platform cannot read yet stay pending: never a false "complete".
  for (const requirement of ["personal_photo", "civil_id", "civil_front", "location"]) assert.ok(second.includes(requirement), requirement);
  const noEmail = await person("candidate");
  assert.ok((await rig(noEmail).write("gender", "male")).ok);
  assert.ok((await store.readPending(noEmail))?.includes("email"));
});

test("SHU143_PG_OWNER only the signed-in candidate's own row changes, and refusals change nothing", async () => {
  const owner = await person();
  const other = await person();
  assert.ok((await rig(other).write("display_name", "Other Person")).ok);
  assert.ok((await rig(owner).write("display_name", "Owner Person")).ok);
  const [ownerRow, otherRow, ownerAudits, otherAudits] = [await row(owner), await row(other), await audits(owner), await audits(other)];
  // The owner's port, aimed at the other person's record or principal.
  for (const options of [
    { personRef: candidateProfileRecordRef(other) },
    { principalRef: principalAuditRef(other), personRef: candidateProfileRecordRef(other) },
  ]) {
    const result = await directCommit(other, "display_name", "Other Person", "Hijacked Name", { ...options, as: owner });
    assert.deepEqual(result, { ok: false, reason: "not_own_record" });
  }
  assert.equal(await row(owner), ownerRow);
  assert.equal(await row(other), otherRow);
  assert.equal(await audits(owner), ownerAudits);
  assert.equal(await audits(other), otherAudits);
  // A staff member has no candidate profile to edit.
  const staff = await person("staff");
  assert.deepEqual(await rig(staff).writer.preview({ principalRef: principalAuditRef(staff), change: rig(staff).change("gender", "male") }),
    { ok: false, reason: "not_own_record" });
  // A grant revoked between confirm's check and the commit stops it.
  await authz.revokeMany(owner, [{ orgId: ORG, role: "candidate" }]);
  assert.deepEqual(await directCommit(owner, "display_name", "Owner Person", "Late Write"), { ok: false, reason: "not_own_record" });
  assert.equal(await row(owner), ownerRow);
});

test("SHU143_PG_STALE a value changed after the preview is not overwritten", async () => {
  const id = await person();
  const x = rig(id);
  const preview = await x.writer.preview({ principalRef: x.principalRef, change: x.change("objective", "First objective") });
  assert.ok(preview.ok);
  assert.ok((await x.write("objective", "Second objective")).ok);
  const late = await x.writer.confirm({ principalRef: x.principalRef, change: x.change("objective", "First objective"), token: preview.token });
  assert.deepEqual(late, { ok: false, reason: "state_changed" });
  assert.equal(await store.forPrincipal(id).readField(candidateProfileRecordRef(id), "objective"), "Second objective");
  // The store compares on its own, for a commit that passed the contract's check just before another writer.
  assert.deepEqual(await directCommit(id, "objective", "First objective", "Third objective"), { ok: false, reason: "state_changed" });
  assert.deepEqual(await directCommit(id, "intro", "Never written", "An intro"), { ok: false, reason: "state_changed" });
  assert.equal(await store.forPrincipal(id).readField(candidateProfileRecordRef(id), "objective"), "Second objective");
  assert.equal(await store.forPrincipal(id).readField(candidateProfileRecordRef(id), "intro"), null);
});

test("SHU143_PG_RACE two confirms of one token store once and report token_already_used", async () => {
  const id = await person();
  const x = rig(id);
  const preview = await x.writer.preview({ principalRef: x.principalRef, change: x.change("preferred_time", "Mornings") });
  assert.ok(preview.ok);
  const both = await Promise.all([1, 2].map(() =>
    x.writer.confirm({ principalRef: x.principalRef, change: x.change("preferred_time", "Mornings"), token: preview.token })));
  assert.equal(both.filter((r) => r.ok).length, 1);
  // The loser is refused either at the store (token spent) or, if the winner committed
  // before the loser read the field, by the contract's own before-value check.
  const loser = both.find((r) => !r.ok);
  assert.ok(loser && !loser.ok && ["token_already_used", "state_changed"].includes(loser.reason), JSON.stringify(loser));
  assert.equal(await audits(id), 1);
  // The same token at the store directly, after a value change, is still spent.
  const tokenId = randomUUID();
  assert.ok((await directCommit(id, "preferred_time", "Mornings", "Evenings", { tokenId })).ok);
  assert.deepEqual(await directCommit(id, "preferred_time", "Evenings", "Weekends", { tokenId }), { ok: false, reason: "token_already_used" });
});

test("SHU143_PG_CATALOGUE_AT_COMMIT a country or university retired after the confirm's check is not stored", async () => {
  const id = await person();
  const retired = await catalogueItem("country");
  await pool.query("UPDATE catalogue_items SET status = 'deleted', deleted_at = $2 WHERE id = $1", [retired, FIXED]);
  assert.deepEqual(await directCommit(id, "nationality", null, retired).catch(failed), { ok: false, reason: "state_changed" });
  // A university id given as a nationality is not a country.
  assert.deepEqual(await directCommit(id, "nationality", null, university).catch(failed), { ok: false, reason: "state_changed" });
  assert.equal(await row(id), "null");
  // The preview refuses it too.
  const x = rig(id);
  assert.deepEqual(await x.writer.preview({ principalRef: x.principalRef, change: x.change("nationality", retired) }),
    { ok: false, reason: "invalid_value" });
  // A stored country retired later leaves the row editable.
  const later = await catalogueItem("country");
  assert.ok((await x.write("nationality", later)).ok);
  await pool.query("UPDATE catalogue_items SET status = 'deleted', deleted_at = $2 WHERE id = $1", [later, FIXED]);
  assert.ok((await x.write("gender", "other")).ok);
});

test("SHU143_PG_UNIQUE a phone or profile URL another person holds is refused at preview and at commit", async () => {
  const first = await person();
  const second = await person();
  const phone = `+9656${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  const slug = `taken-${randomUUID().slice(0, 8)}`;
  assert.ok((await rig(first).write("phone", phone)).ok);
  assert.ok((await rig(first).write("profile_url", slug)).ok);
  const x = rig(second);
  for (const [field, value] of [["phone", phone], ["profile_url", slug]] as const) {
    assert.deepEqual(await x.writer.preview({ principalRef: x.principalRef, change: x.change(field, value) }), { ok: false, reason: "invalid_value" });
    assert.deepEqual(await directCommit(second, field, null, value).catch(failed), { ok: false, reason: "state_changed" });
  }
  // Writing your own current value again is not a conflict with yourself.
  assert.equal(await selfEditValueCheck(store.referencesFor(first), { today: () => TODAY })("phone", phone), undefined);
});

test("SHU143_PG_SCHEMA the table and the ledger refuse malformed rows from any writer", async () => {
  const id = await person();
  const insert = (column: string, value: unknown) => pool.query(
    `INSERT INTO candidate_profiles (principal_id, ${column}, pending_fields) VALUES ($1, $2, '{}')`, [id, value]);
  const refused = async (column: string, value: unknown, codes = ["23514"]) => {
    await assert.rejects(insert(column, value), (error: { code?: string }) => codes.includes(error.code ?? ""), `${column} ${JSON.stringify(value)}`);
  };
  await refused("display_name", "Single");
  await refused("display_name", "Two  Spaces");
  await refused("display_name", " Lead Space");
  await refused("display_name", "Zero​width name");
  await refused("display_name", "Ａb Cd");
  await refused("arabic_name", "x".repeat(254) + " y");
  await refused("objective", "x".repeat(101));
  await refused("objective", "Tab\tinside");
  await refused("intro", "Three\n\n\nbreaks");
  await refused("intro", "Edge \nspace");
  await refused("intro", "\nLeading");
  await refused("gender", "unknown");
  await refused("birth_date", "1899-12-31");
  await refused("profile_url", "Upper-Case");
  await refused("phone", "+965 5555");
  await refused("job_search_status", "active");
  for (const pending of [["identity_reference"], ["skill", null]]) {
    await assert.rejects(pool.query("INSERT INTO candidate_profiles (principal_id, pending_fields) VALUES ($1, $2)", [id, pending]),
      (error: { code?: string }) => error.code === "23514", JSON.stringify(pending));
  }
  await refused("nationality_id", await catalogueItem("country", "deleted"));
  await refused("nationality_id", university, ["23503", "23514"]);
  await refused("university_id", country, ["23503", "23514"]);
  // The ledger refuses a profile receipt that names a value or an unknown field.
  const ref = principalAuditRef(id);
  for (const fields of [["display_name", "Synthetic Person"], ["civil_id"], [42]]) {
    await assert.rejects(pool.query(
      `INSERT INTO authorization_mutation_audit (request_ref, actor_principal_ref, operation, target_principal_ref, target_org_refs, before_summary, after_summary)
       VALUES ($1, $2, $3, $2, '{}'::text[], '{"valuePresent":false}'::jsonb, $4::jsonb)`,
      [randomUUID().replaceAll("-", "").padEnd(64, "0"), ref, CANDIDATE_PROFILE_OPERATION, JSON.stringify({
        contractVersion: "3.0.0", personRef: "c".repeat(64), changeSetDigest: "b".repeat(64), fields,
        committedAt: FIXED.toISOString(), tokenRef: "e".repeat(64),
      })]), (error: { code?: string }) => error.code === "23514", JSON.stringify(fields));
  }
  // Someone else's actor reference is refused: a safe write is self-authored.
  await assert.rejects(pool.query(
    `INSERT INTO authorization_mutation_audit (request_ref, actor_principal_ref, operation, target_principal_ref, target_org_refs, before_summary, after_summary)
     VALUES ($1, $2, $3, $4, '{}'::text[], '{"valuePresent":false}'::jsonb, $5::jsonb)`,
    [randomUUID().replaceAll("-", "").padEnd(64, "0"), "f".repeat(64), CANDIDATE_PROFILE_OPERATION, ref, JSON.stringify({
      contractVersion: "3.0.0", personRef: "c".repeat(64), changeSetDigest: "b".repeat(64), fields: ["gender"],
      committedAt: FIXED.toISOString(), tokenRef: "e".repeat(64),
    })]), (error: { code?: string }) => error.code === "23514");
  // A forged receipt row for this person is never served.
  const forged = randomUUID().replaceAll("-", "").padEnd(64, "0");
  await pool.query(
    `INSERT INTO authorization_mutation_audit (request_ref, actor_principal_ref, operation, target_principal_ref, target_org_refs, before_summary, after_summary)
     VALUES ($1, $2, $3, $2, '{}'::text[], '{"valuePresent":false}'::jsonb, $4::jsonb)`,
    [forged, ref, CANDIDATE_PROFILE_OPERATION, JSON.stringify({
      contractVersion: "3.0.0", personRef: candidateProfileRecordRef(await person()), changeSetDigest: "b".repeat(64), fields: ["gender"],
      committedAt: FIXED.toISOString(), tokenRef: randomUUID().replaceAll("-", "").padEnd(64, "9"),
    })]);
  assert.equal(await store.readReceipt(id, forged).catch(() => "threw"), "threw");
});

test("SHU143_PG_TEXT_AGREES the database and the application accept exactly the same text, code point by code point", async () => {
  const { rows } = await pool.query<{ cp: number; name: boolean; line: boolean; intro: boolean; tail: boolean }>(
    `SELECT cp,
            candidate_person_name_valid('Ab' || chr(cp) || ' Cd') AS name,
            candidate_profile_line_valid('Ab' || chr(cp) || 'Cd', 100) AS line,
            candidate_profile_intro_valid('Ab' || chr(cp) || 'Cd') AS intro,
            candidate_profile_line_valid('Ab' || chr(cp), 100) AS tail
       FROM generate_series(1, 1114111) AS cp WHERE cp NOT BETWEEN 55296 AND 57343`);
  const line = (text: string) => normalizeSelfEdit("objective", text) === text;
  const disagreements: string[] = [];
  for (const r of rows) {
    const char = String.fromCodePoint(r.cp);
    const checks: Array<[string, boolean, boolean]> = [
      ["name", r.name, normalizePersonName(`Ab${char} Cd`) === `Ab${char} Cd`],
      ["line", r.line, line(`Ab${char}Cd`)],
      ["intro", r.intro, normalizeIntro(`Ab${char}Cd`) === `Ab${char}Cd`],
      ["tail", r.tail, line(`Ab${char}`)],
    ];
    for (const [kind, database, application] of checks) {
      if (database !== application) disagreements.push(`U+${r.cp.toString(16).toUpperCase()} ${kind}`);
    }
  }
  assert.equal(rows.length, 1_112_063);
  assert.deepEqual(disagreements.slice(0, 50), [], `${disagreements.length} disagreements`);
  const samples = ["Synthetic Person", "شخص تجريبي", "Single", "Two  Spaces", "x".repeat(255), "x".repeat(253) + " y", "x".repeat(254) + " y",
    "Café Bar", "First\nSecond", "First\n\nSecond", "First\n\n\nSecond", "Edge \nspace", "\u{1F600} \u{1F600}"];
  const named = await pool.query<{ t: string; name: boolean; intro: boolean; line: boolean }>(
    `SELECT t, candidate_person_name_valid(t) AS name, candidate_profile_intro_valid(t) AS intro,
            candidate_profile_line_valid(t, 100) AS line FROM unnest($1::text[]) AS t`, [samples]);
  for (const r of named.rows) {
    assert.equal(r.name, normalizePersonName(r.t) === r.t, `name ${JSON.stringify(r.t)}`);
    assert.equal(r.intro, normalizeIntro(r.t) === r.t, `intro ${JSON.stringify(r.t)}`);
    assert.equal(r.line, line(r.t), `line ${JSON.stringify(r.t)}`);
  }
});

test("SHU143_PG_VALUES_AGREE the database accepts exactly the canonical values of the structured fields", async () => {
  const id = await person();
  // Unique per run: phone numbers are unique across the table.
  const digits = String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
  const cases: Array<[SelfEditField, string, string]> = [
    ["phone", "phone", `+9657${digits}`], ["phone", "phone", `9658${digits}`], ["phone", "phone", `+${digits}`], ["phone", "phone", `+123456789${digits}`],
    ["phone", "phone", digits.slice(0, 5)], ["phone", "phone", `+9659${digits} `], ["profile_url", "profile_url", "ab"], ["profile_url", "profile_url", `u${digits}`],
    ["profile_url", "profile_url", `a-${digits}`], ["profile_url", "profile_url", `a${"b".repeat(55)}${digits}`],
    ["profile_url", "profile_url", `a${"b".repeat(56)}${digits}`],
    ["profile_url", "profile_url", "ab-"], ["profile_url", "profile_url", "a_b"], ["gender", "gender", "male"], ["gender", "gender", "Male"],
    ["birth_date", "birth_date", "1900-01-01"], ["birth_date", "birth_date", "1899-12-31"],
  ];
  for (const [field, column, value] of cases) {
    const database = await pool.query(
      `INSERT INTO candidate_profiles (principal_id, ${column}, pending_fields) VALUES ($1, $2, '{}')
       ON CONFLICT (principal_id) DO UPDATE SET ${column} = EXCLUDED.${column}`, [id, value])
      .then(() => true, () => false);
    assert.equal(database, normalizeSelfEdit(field, value) === value, `${field} ${JSON.stringify(value)}`);
  }
});
