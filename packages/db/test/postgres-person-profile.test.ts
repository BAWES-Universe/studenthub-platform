import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresPersonProfileStore, PostgresSafeWriteStore, personRecordRef, principalAuditRef, requestAuditRef, runMigrations, safeWritePrincipalRef } from "@studenthub/db";
import { InMemoryApprovedProfileAdapter, OwnProfileRepository, SHU372_RULES, SYNTHETIC_PROFILE_FIXTURES, createPersonSelfEdit, createPersonImportedFallbackReader } from "@studenthub/profile";
import { profileDocument, type BrowserLoginApplication } from "../../../apps/gateway/src/web-ui.js";

import { PostgresPersonProfileStore as BrowserPostgresPersonProfileStore, PersonProfileBrowserRetryableError, type PersonProfileBrowserOptions } from "../src/person-profile-store.js";
import { readLiveLoginSessionPerson } from "../src/postgres-login-store.js";
import { browserBaselineDigest, browserChangeSetDigest, createBrowserWriteTokens, type BrowserWriteToken } from "@studenthub/safe-write-contract";

const url = process.env.DATABASE_URL ?? "";
let pool: pg.Pool;
before(async () => { if (!url) throw new Error("DATABASE_URL is required to run the db suite"); pool = new pg.Pool({ connectionString: url }); await runMigrations(pool); });
after(async () => pool.end());

test("SHU392_PG_RULES the CHECK and application share every SHU372_RULES example", async () => {
  // The choice fields (gender, birthDate, drivingLicence, jobSearchStatus) are
  // constrained by their own column CHECKs, not the shared text validator.
  const textFields = new Set(["displayName", "arabicName", "objective", "intro", "preferredTime"]);
  for (const [field, rule] of Object.entries(SHU372_RULES)) {
    if (!textFields.has(field)) continue;
    const requireWords = field === "displayName" || field === "arabicName";
    for (const value of rule.accepts) {
      if (value === "") continue; // clearing is represented by SQL NULL
      assert.equal((await pool.query<{ ok: boolean }>("SELECT person_profile_text_valid($1,$2,$3,$4) ok", [value, rule.maxLength, requireWords, field === "arabicName"])).rows[0]!.ok, true, `${field} accepts ${value}`);
    }
    for (const value of rule.refuses) assert.equal((await pool.query<{ ok: boolean }>("SELECT person_profile_text_valid($1,$2,$3,$4) ok", [value, rule.maxLength, requireWords, field === "arabicName"])).rows[0]!.ok, false, `${field} refuses ${value}`);
  }
});

test("SHU392_PG_AUDIT an untouched 0205 audit operation still inserts", async () => {
  const marker = randomUUID();
  const ref = requestAuditRef(`shu392-${marker}`), principal = principalAuditRef(`shu392-${marker}`);
  const summary = JSON.stringify({ grantCount: 0, selfCount: 0, subtreeCount: 0 });
  await pool.query(`INSERT INTO authorization_mutation_audit
    (request_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary)
    VALUES($1,'grants.grant',$2,$3::text[],$4::jsonb,$4::jsonb)`, [ref, principal, [requestAuditRef(`org-${marker}`)], summary]);
  assert.equal((await pool.query("SELECT 1 FROM authorization_mutation_audit WHERE request_ref=$1", [ref])).rowCount, 1);
});

test("SHU392_PG_NFC the database refuses decomposed text", async () => {
  assert.equal((await pool.query<{ ok: boolean }>("SELECT person_profile_text_valid($1,255,true) ok", ["Noe\u0308l Al-Sabah"])).rows[0]!.ok, false);
});

test("SHU392_PG_CROSS_RECEIPTS each card treats the other card's receipt as absent", async () => {
  const id = `shu392-${randomUUID()}`;
  const authz = new PostgresAuthzStore(pool);
  await authz.registerPrincipal(createPrincipal({ id, email: `${id}@example.invalid`, pbuuids: [] }));
  const principal = safeWritePrincipalRef(id), person = personRecordRef(id);
  const insert = async (field: string, marker: string) => {
    const receipt = requestAuditRef(`${id}-${marker}`);
    await pool.query(`INSERT INTO authorization_mutation_audit
      (request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary)
      VALUES($1,$2,'profile.safe_write',$2,'{}',$3::jsonb,$4::jsonb)`, [receipt, principal,
      JSON.stringify({ valuePresent: false }), JSON.stringify({ contractVersion: "3.0.0", personRef: person, changeSetDigest: "c".repeat(64), fields: [field], committedAt: "2026-10-30T01:00:00.000Z", tokenRef: requestAuditRef(`${id}-${marker}-token`) })]);
    return receipt;
  };
  const profileReceipt = await insert("objective", "profile"), languageReceipt = await insert("language", "language");
  const profiles = new PostgresPersonProfileStore({ pool }), languages = new PostgresSafeWriteStore({ pool });
  assert.equal(await profiles.readReceipt(id, languageReceipt), null);
  assert.equal(await languages.readReceipt(id, profileReceipt), null);
});

test("SHU372_WRITE Postgres commits, clears, replays safely, and cascades principal deletion", async () => {
  const id = `shu392-${randomUUID()}`, other = `shu392-${randomUUID()}`;
  const authz = new PostgresAuthzStore(pool);
  for (const principalId of [id, other]) await authz.registerPrincipal(createPrincipal({ id: principalId, email: `${principalId}@example.invalid`, pbuuids: [] }));
  const store = new PostgresPersonProfileStore({ pool });
  const writer = () => createPersonSelfEdit({ store: store.forPrincipal(id), secret: "s".repeat(32) });
  const request = (value: string) => ({ principalRef: safeWritePrincipalRef(id), change: { personRef: personRecordRef(id), field: "objective", value } });
  const first = request("Build teams"), preview = await writer().preview(first); assert.ok(preview.ok);
  if (!preview.ok) return;
  assert.ok((await writer().confirm({ ...first, token: preview.token })).ok);
  const noop = await writer().preview(first); assert.ok(noop.ok);
  if (!noop.ok) return;
  assert.ok((await writer().confirm({ ...first, token: noop.token })).ok);
  assert.deepEqual(await writer().confirm({ ...first, token: noop.token }), { ok: false, reason: "token_already_used" });
  const clear = request(""), clearing = await writer().preview(clear); assert.ok(clearing.ok);
  if (!clearing.ok) return;
  assert.ok((await writer().confirm({ ...clear, token: clearing.token })).ok);
  const preferences = await store.readOwnPreferences(id) as Record<string, { value: unknown; updatedAt: string }> | null;
  assert.equal(preferences?.objective?.value, null);
  assert.equal(typeof preferences?.objective?.updatedAt, "string");
  await pool.query("DELETE FROM principals WHERE id=$1", [id]);
  assert.equal((await pool.query("SELECT 1 FROM person_profiles WHERE principal_id=$1", [id])).rowCount, 0);
});

test("SHU395_PG_S1 Postgres writes and clears override a populated snapshot on My profile", async () => {
  const id = `shu395-${randomUUID()}`, candidateRef = `candidate-${randomUUID()}`;
  const authz = new PostgresAuthzStore(pool);
  await authz.registerPrincipal(createPrincipal({ id, email: `${id}@example.invalid`, pbuuids: [candidateRef] }));
  const store = new PostgresPersonProfileStore({ pool });
  const writer = () => createPersonSelfEdit({ store: store.forPrincipal(id), secret: "s".repeat(32) });
  const write = async (value: string) => {
    const request = { principalRef: safeWritePrincipalRef(id), change: { personRef: personRecordRef(id), field: "objective" as const, value } };
    const preview = await writer().preview(request); assert.ok(preview.ok); if (!preview.ok) return;
    assert.ok((await writer().confirm({ ...request, token: preview.token })).ok);
  };
  const profiles = new OwnProfileRepository({ principals: authz, source: new InMemoryApprovedProfileAdapter({
    links: [{ principalId: id, candidateRef }], rows: new Map([[candidateRef, SYNTHETIC_PROFILE_FIXTURES.populated]]),
  }), preferences: store as never, today: () => "2026-10-30" });
  const render = async () => {
    const found = await profiles.readOwn({ requesterPrincipalId: id, targetPersonId: id }); assert.equal(found.kind, "found");
    if (found.kind !== "found") throw new Error("profile missing");
    return (await profileDocument({ status: 200, body: found.profile }, { profileEdit: {} } as BrowserLoginApplication)).html;
  };
  await write("Postgres objective");
  assert.match(await render(), /<dt>Objective<\/dt><dd>Postgres objective<\/dd><small class="field-meta">Updated by you/);
  await write("");
  const cleared = await render();
  assert.match(cleared, /<dt>Objective<\/dt><dd><span class="missing"[^>]*>Not recorded<\/span><\/dd><small class="field-meta">Updated by you/);
  assert.doesNotMatch(cleared, /Build welcoming customer experiences/);
});

test("SHU372_OWNER Postgres refuses another person and a stale before value", async () => {
  const id = `shu392-${randomUUID()}`, authz = new PostgresAuthzStore(pool);
  await authz.registerPrincipal(createPrincipal({ id, email: `${id}@example.invalid`, pbuuids: [] }));
  const store = new PostgresPersonProfileStore({ pool }), writer = createPersonSelfEdit({ store: store.forPrincipal(id), secret: "s".repeat(32) });
  const principalRef = safeWritePrincipalRef(id), change = { personRef: personRecordRef(id), field: "objective", value: "Build teams" };
  assert.deepEqual(await writer.preview({ principalRef, change: { ...change, personRef: "c".repeat(64) } }), { ok: false, reason: "not_own_record" });
  const preview = await writer.preview({ principalRef, change }); assert.ok(preview.ok);
  if (!preview.ok) return;
  await pool.query("INSERT INTO person_profiles(principal_id,objective,objective_written_at) VALUES($1,'Concurrent',clock_timestamp())", [id]);
  assert.deepEqual(await writer.confirm({ principalRef, change, token: preview.token }), { ok: false, reason: "state_changed" });
});

test("SHU413_WRITE Postgres writes every choice twice with stable text state", async () => {
  const id = `shu413-${randomUUID()}`, authz = new PostgresAuthzStore(pool);
  await authz.registerPrincipal(createPrincipal({ id, email: `${id}@example.invalid`, pbuuids: [] }));
  const store = new PostgresPersonProfileStore({ pool });
  const writer = () => createPersonSelfEdit({ store: store.forPrincipal(id), secret: "s".repeat(32), clock: { now: () => new Date("2026-10-30T12:00:00.000Z") } });
  const changes = { gender: ["male", "female"], birthDate: ["2000-02-28", "2000-02-29"], drivingLicence: ["true", "false"], jobSearchStatus: ["active", "open_to_offers"] } as const;
  for (const [field, values] of Object.entries(changes)) {
    for (const [attempt, value] of values.entries()) {
      const change = { personRef: personRecordRef(id), field, value }, principalRef = safeWritePrincipalRef(id);
      const preview = await writer().preview({ principalRef, change }); assert.ok(preview.ok, `${field} preview ${attempt}`);
      if (preview.ok) assert.ok((await writer().confirm({ principalRef, change, token: preview.token })).ok, `${field} confirm ${attempt}`);
    }
  }
  const preferences = await store.readOwnPreferences(id) as Record<string, { value: unknown; updatedAt: string }>;
  assert.deepEqual(Object.fromEntries(Object.entries(preferences).filter(([key]) => ["gender", "birthDate", "drivingLicence", "jobSearchStatus"].includes(key)).map(([key, entry]) => [key, entry.value])),
    { gender: "female", birthDate: "2000-02-29", drivingLicence: "false", jobSearchStatus: "open_to_offers" });
  for (const field of Object.keys(changes)) assert.match(preferences[field]!.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("SHU374_UNIQUE Postgres writes contact fields twice and gives every phone holder the same refusal", async () => {
  const ids = [`shu374-${randomUUID()}`, `shu374-${randomUUID()}`], authz = new PostgresAuthzStore(pool);
  for (const id of ids) await authz.registerPrincipal(createPrincipal({ id, email: `${id}@example.invalid`, pbuuids: [] }));
  const store = new PostgresPersonProfileStore({ pool });
  const preview = async (id: string, field: "phone" | "handle", value: string) => {
    const writer = createPersonSelfEdit({ store: store.forPrincipal(id), secret: "s".repeat(32) });
    const principalRef = safeWritePrincipalRef(id), change = { personRef: personRecordRef(id), field, value };
    const result = await writer.preview({ principalRef, change });
    return { result, writer, principalRef, change };
  };
  const write = async (id: string, field: "phone" | "handle", value: string) => {
    const attempt = await preview(id, field, value); assert.ok(attempt.result.ok); if (!attempt.result.ok) return attempt.result;
    return attempt.writer.confirm({ principalRef: attempt.principalRef, change: attempt.change, token: attempt.result.token });
  };
  const suffix = BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString().slice(0, 11);
  const phone = `+44${suffix}`, racePhone = `+33${suffix}`;
  assert.ok((await write(ids[0]!, "phone", phone)).ok);
  assert.ok((await write(ids[0]!, "phone", phone)).ok);
  assert.ok((await write(ids[0]!, "handle", `first.${suffix}`)).ok);
  assert.ok((await write(ids[0]!, "handle", `first_${suffix}`)).ok);
  assert.deepEqual((await preview(ids[1]!, "phone", phone)).result, { ok: false, reason: "invalid_value" });
  assert.deepEqual((await preview(ids[1]!, "handle", `first_${suffix}`)).result, { ok: false, reason: "invalid_value" });
  const racers = await Promise.all(ids.map(id => preview(id, "phone", racePhone)));
  assert.ok(racers.every(attempt => attempt.result.ok));
  const outcomes = await Promise.all(racers.map(attempt => attempt.result.ok
    ? attempt.writer.confirm({ principalRef: attempt.principalRef, change: attempt.change, token: attempt.result.token }) : attempt.result));
  assert.deepEqual(outcomes.map(outcome => outcome.ok).sort(), [false, true]);
  assert.equal(outcomes.find(outcome => !outcome.ok)?.reason, "invalid_value");
  // Mutation checked manually: dropping person_profiles_phone_uq makes both
  // racing confirmations above succeed, so the [false, true] assertion fails.
  const preferences = await store.readOwnPreferences(ids[0]!) as Record<string, { value: unknown }>;
  assert.equal(preferences.handle!.value, `first_${suffix}`);
});

test("SHU415_CATALOGUE choices contain only active countries and universities", async () => {
  const actor = "a".repeat(64), now = "2026-10-30T00:00:00.000Z", suffix = randomUUID();
  const items = [
    ["41111111-1111-4111-8111-111111111111", "country", `SHU415 Kuwait ${suffix}`, `shu415 kuwait ${suffix}`, "KW", "active", null],
    ["42222222-2222-4222-8222-222222222222", "university", `SHU415 University ${suffix}`, `shu415 university ${suffix}`, null, "active", null],
    ["43333333-3333-4333-8333-333333333333", "country", `SHU415 deleted country ${suffix}`, `shu415 deleted country ${suffix}`, "DC", "deleted", now],
    ["44444444-4444-4444-8444-444444444444", "university", `SHU415 deleted university ${suffix}`, `shu415 deleted university ${suffix}`, null, "deleted", now],
  ] as const;
  for (const item of items) await pool.query(`INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,code,status,created_by_ref,updated_by_ref,created_at,updated_at,deleted_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$8,$9) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status,deleted_at=EXCLUDED.deleted_at`, [...item.slice(0, 6), actor, now, item[6]]);
  const choices = await new PostgresPersonProfileStore({ pool }).readOriginChoices();
  assert.ok(choices.countries.some(item => item.id === items[0][0]));
  assert.ok(choices.universities.some(item => item.id === items[1][0]));
  assert.ok(!choices.countries.some(item => item.id === items[2][0]));
  assert.ok(!choices.universities.some(item => item.id === items[3][0]));
  // The profile read resolves stored ids through the same catalogue rows that
  // supply the controls; ids are edit values and names are what people see.
  const id = `shu415-catalogue-${randomUUID()}`;
  await new PostgresAuthzStore(pool).registerPrincipal(createPrincipal({ id, email: `${id}@example.invalid`, pbuuids: [] }));
  await pool.query(`INSERT INTO person_profiles(principal_id,nationality_id,nationality_id_written_at,university_id,university_id_written_at)
    VALUES($1,$2,$3,$4,$3)`, [id, items[0][0], now, items[1][0]]);
  const preferences = await new PostgresPersonProfileStore({ pool }).readOwnPreferences(id) as Record<string, { value: unknown; editValue?: string }>;
  assert.deepEqual(preferences.nationality, { value: items[0][2], editValue: items[0][0], updatedAt: now });
  assert.deepEqual(preferences.university, { value: items[1][2], editValue: items[1][0], updatedAt: now });
  const profiles = new OwnProfileRepository({ principals: new PostgresAuthzStore(pool), source: {
    resolveLink: async () => ({ kind: "unconfigured" as const }), readCandidate: async () => undefined,
  }, preferences: new PostgresPersonProfileStore({ pool }) as never, today: () => "2026-10-30" });
  const found = await profiles.readOwn({ requesterPrincipalId: id, targetPersonId: id });
  assert.equal(found.kind, "found");
  if (found.kind === "found") {
    const html = (await profileDocument({ status: 200, body: found.profile }, {} as BrowserLoginApplication)).html;
    assert.match(html, new RegExp(`<dt>Nationality</dt><dd>${items[0][2]}</dd>`));
    assert.match(html, new RegExp(`<dt>University</dt><dd>${items[1][2]}</dd>`));
    assert.doesNotMatch(html, new RegExp(`${items[0][0]}|${items[1][0]}`));
  }
});

test("SHU415_WRITE origin fields write twice, commit resolves active ids, None is NULL, and Kuwaiti nationality clears mother", async () => {
  const id = `shu415-${randomUUID()}`, authz = new PostgresAuthzStore(pool), store = new PostgresPersonProfileStore({ pool });
  await authz.registerPrincipal(createPrincipal({ id, email: `${id}@example.invalid`, pbuuids: [] }));
  const principalRef = safeWritePrincipalRef(id), writer = () => createPersonSelfEdit({ store: store.forPrincipal(id), secret: "s".repeat(32) });
  const write = async (field: "nationality" | "university" | "kuwaitiMother", value: string) => {
    const change = { personRef: personRecordRef(id), field, value }, preview = await writer().preview({ principalRef, change });
    assert.ok(preview.ok, `${field}:${value} previews`); if (!preview.ok) return preview;
    const result = await writer().confirm({ principalRef, change, token: preview.token }); assert.ok(result.ok); return result;
  };
  const country = "45555555-5555-4555-8555-555555555555", university = "42222222-2222-4222-8222-222222222222", actor = "a".repeat(64), now = "2026-10-30T00:00:00.000Z";
  await pool.query(`INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,code,status,created_by_ref,updated_by_ref,created_at,updated_at)
    VALUES($1,'country','Bahrain','bahrain','BH','active',$2,$2,$3,$3) ON CONFLICT(id) DO NOTHING`, [country, actor, now]);
  await pool.query(`INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,status,created_by_ref,updated_by_ref,created_at,updated_at)
    VALUES($1,'university','Kuwait University','kuwait university','active',$2,$2,$3,$3) ON CONFLICT(id) DO NOTHING`, [university, actor, now]);
  for (const value of [country, country]) await write("nationality", value);
  for (const value of [university, university, ""]) await write("university", value);
  for (const value of ["true", "false", ""]) await write("kuwaitiMother", value);
  const cleared = (await pool.query("SELECT university_id,kuwaiti_mother FROM person_profiles WHERE principal_id=$1", [id])).rows[0];
  assert.equal(cleared?.university_id, null);
  assert.equal(cleared?.kuwaiti_mother, null);
  for (const field of ["nationality", "university"] as const) for (const value of ["46666666-6666-4666-8666-666666666666", field === "nationality" ? "43333333-3333-4333-8333-333333333333" : "44444444-4444-4444-8444-444444444444"]) {
    assert.deepEqual(await writer().preview({ principalRef, change: { personRef: personRecordRef(id), field, value } }), { ok: false, reason: "invalid_value" });
    assert.equal((await pool.query("SELECT university_id FROM person_profiles WHERE principal_id=$1", [id])).rows[0]?.university_id, null);
  }
  const commitWriter = writer(), commitChange = { personRef: personRecordRef(id), field: "university" as const, value: university };
  const inactivePreview = await commitWriter.preview({ principalRef, change: commitChange });
  assert.ok(inactivePreview.ok);
  if (inactivePreview.ok) {
    await pool.query("UPDATE catalogue_items SET status='deleted',deleted_at=$2 WHERE id=$1", [university, now]);
    assert.deepEqual(await commitWriter.confirm({ principalRef, change: commitChange, token: inactivePreview.token }), { ok: false, reason: "invalid_value" });
    await pool.query("UPDATE catalogue_items SET status='active',deleted_at=NULL WHERE id=$1", [university]);
  }
  const missingWriter = writer(), missingPreview = await missingWriter.preview({ principalRef, change: commitChange });
  assert.ok(missingPreview.ok);
  if (missingPreview.ok) {
    await pool.query("DELETE FROM catalogue_items WHERE id=$1", [university]);
    assert.deepEqual(await missingWriter.confirm({ principalRef, change: commitChange, token: missingPreview.token }), { ok: false, reason: "invalid_value" });
    await pool.query(`INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,status,created_by_ref,updated_by_ref,created_at,updated_at)
      VALUES($1,'university','Kuwait University','kuwait university','active',$2,$2,$3,$3)`, [university, actor, now]);
  }
  await write("kuwaitiMother", "false");
  const kuwait = "41111111-1111-4111-8111-111111111111";
  await write("nationality", kuwait);
  for (const value of ["true", "false", ""]) assert.deepEqual(await writer().preview({ principalRef, change: { personRef: personRecordRef(id), field: "kuwaitiMother", value } }), { ok: false, reason: "invalid_value" });
  await assert.rejects(pool.query("UPDATE person_profiles SET kuwaiti_mother=false WHERE principal_id=$1", [id]), (error: { code?: string }) => error.code === "23514");
  const guarded = (await pool.query("SELECT nationality_id,kuwaiti_mother FROM person_profiles WHERE principal_id=$1", [id])).rows[0];
  assert.equal(guarded?.nationality_id, kuwait);
  assert.equal(guarded?.kuwaiti_mother, null);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const browserKeys = { activeKeyVersion: "key1", keys: { key1: "browser-test-key-".repeat(4) } };
const sessionHash = (token: string) => createHash("sha256").update(token).digest("base64url");

async function browserFixture() {
  const id = `u2a-${randomUUID()}`, sessionToken = randomUUID();
  await new PostgresAuthzStore(pool).registerPrincipal(createPrincipal({ id, email: `${id}@example.invalid`, pbuuids: [] }));
  await pool.query("INSERT INTO login_sessions(id,person_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [sessionHash(sessionToken), id]);
  const tokens = createBrowserWriteTokens(browserKeys);
  let row: unknown = { ...SYNTHETIC_PROFILE_FIXTURES.populated };
  const fallback = createPersonImportedFallbackReader({ source: {
    resolveLink: async principal => { assert.equal(principal, id); return { kind: "linked", candidateRef: `candidate-${id}` }; },
    readCandidate: async () => row,
  }, today: () => "2026-10-30" });
  const options: PersonProfileBrowserOptions = { principalId: id, sessionToken, tokens, normalizationVersion: "profile-v1",
    sessionLiveness: { read: readLiveLoginSessionPerson }, importedFallback: fallback };
  const store = new BrowserPostgresPersonProfileStore({ pool });
  const api = store.forBrowserSession(options);
  const snapshot = async () => ({
    profile: (await pool.query("SELECT * FROM person_profiles WHERE principal_id=$1", [id])).rows,
    audit: (await pool.query("SELECT * FROM authorization_mutation_audit WHERE target_principal_ref=$1 AND operation='profile.safe_write' ORDER BY request_ref", [safeWritePrincipalRef(id)])).rows,
    allAudit: (await pool.query("SELECT * FROM authorization_mutation_audit WHERE target_principal_ref=$1 ORDER BY request_ref", [safeWritePrincipalRef(id)])).rows,
    sessions: (await pool.query("SELECT * FROM login_sessions WHERE person_id=$1 ORDER BY id", [id])).rows,
  });
  const tokenAt = async (now: Date) => {
    const issued = await api.issue("objective");
    return tokens.issue(issued, issued.baselineDigest, now);
  };
  return { id, sessionToken, options, tokens, store, api, snapshot, tokenAt, setRow: (value: unknown) => { row = value; } };
}

/** Execute real SQL, replacing only the selected client boundary with a deterministic fault. */
function interceptPool(intercept: (sql: string, run: () => Promise<unknown>) => Promise<unknown>): pg.Pool {
  return new Proxy(pool, { get(target, property) {
    if (property === "connect") return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, key) {
        if (key === "query") return (query: string, values?: unknown[]) => intercept(query, () => connection.query(query, values));
        const member = Reflect.get(connection, key);
        return typeof member === "function" ? member.bind(connection) : member;
      } });
    };
    const member = Reflect.get(target, property);
    return typeof member === "function" ? member.bind(target) : member;
  } });
}

async function databaseNow() { return (await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now; }

async function holdBrowserLock(id: string) {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5959))", [id]);
  return async () => { try { await client.query("ROLLBACK"); } finally { client.release(); } };
}

test("U2A_ONE_COMMIT concurrent connections spend one token once and preserve receipt A after edit B", async () => {
  const x = await browserFixture(), token = await x.api.issue("objective");
  const second = new BrowserPostgresPersonProfileStore({ pool }).forBrowserSession(x.options);
  const results = await Promise.all([x.api.save({ token, canonicalValue: "Objective A" }), second.save({ token, canonicalValue: "Objective A" })]);
  assert.deepEqual(results.map(result => result.status).sort(), ["already_committed", "committed"]);
  const a = results.find(result => result.status === "committed")!;
  assert.ok("receipt" in a);
  if (!("receipt" in a)) return;
  assert.deepEqual(results.map(result => "receipt" in result ? result.receipt : null), [a.receipt, a.receipt]);
  let state = await x.snapshot();
  assert.equal(state.profile.length, 1); assert.equal(state.profile[0]!.objective, "Objective A"); assert.equal(state.audit.length, 1);
  assert.equal(state.audit[0]!.after_summary.tokenRef, token.tokenRef);
  const bToken = await x.api.issue("objective");
  assert.equal((await x.api.save({ token: bToken, canonicalValue: "Objective B" })).status, "committed");
  state = await x.snapshot();
  assert.deepEqual(await x.api.save({ token, canonicalValue: "Objective A" }), { status: "already_committed", receipt: a.receipt });
  assert.deepEqual(await x.api.save({ token, canonicalValue: "Different payload" }), { status: "token_payload_mismatch" });
  assert.deepEqual(await x.api.receiptStatus(token), { status: "committed", receipt: a.receipt });
  assert.deepEqual(await x.snapshot(), state, "replay and status never rewrite B or add audit rows");
  assert.equal(state.profile[0]!.objective, "Objective B"); assert.equal(state.audit.length, 2);
});

test("U2A_REPLAY receipt recovery precedes expiry and baselines while expired unspent tokens cannot write", async () => {
  const x = await browserFixture();
  const now = await databaseNow();
  const token = await x.tokenAt(new Date(now.getTime() - 299_000));
  const committed = await x.api.save({ token, canonicalValue: "Durable result" });
  assert.equal(committed.status, "committed");
  if (!("receipt" in committed)) return;
  await pool.query("SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.05)", [token.expiresAt]);
  const before = await x.snapshot();
  assert.deepEqual(await x.api.save({ token, canonicalValue: "Durable result" }), { status: "already_committed", receipt: committed.receipt });
  assert.deepEqual(await x.api.save({ token, canonicalValue: "Changed" }), { status: "token_payload_mismatch" });
  assert.deepEqual(await x.api.receiptStatus(token), { status: "committed", receipt: committed.receipt });
  const expired = await x.tokenAt(new Date((await databaseNow()).getTime() - 301_000));
  assert.deepEqual(await x.api.save({ token: expired, canonicalValue: "Never saved" }), { status: "expired" });
  assert.deepEqual(await x.api.receiptStatus(expired), { status: "not_found" });
  assert.deepEqual(await x.snapshot(), before);
  const retired = x.store.forBrowserSession({ ...x.options, tokens: createBrowserWriteTokens({ activeKeyVersion: "key2", keys: { key2: "k".repeat(32) } }) });
  assert.deepEqual(await retired.save({ token, canonicalValue: "Durable result" }), { status: "recovery_unavailable" });
  assert.deepEqual(await retired.receiptStatus(token), { status: "recovery_unavailable" });
});

test("U2A_FALLBACK rechecks exact shown values under lock and explicit clears hide imports", async () => {
  const x = await browserFixture(), token = await x.api.issue("objective"), before = await x.snapshot();
  const locked = deferred(), unlock = await holdBrowserLock(x.id);
  const raced = new BrowserPostgresPersonProfileStore({ pool: interceptPool(async (sql, run) => {
    if (sql.includes("pg_advisory_xact_lock")) { const pending = run(); locked.resolve(); return pending; }
    return run();
  }) }).forBrowserSession(x.options);
  const pending = raced.save({ token, canonicalValue: "Draft" });
  try {
    await locked.promise;
    x.setRow({ ...SYNTHETIC_PROFILE_FIXTURES.populated, candidate_objective: "Changed during lock wait" });
  } finally { await unlock(); }
  assert.deepEqual(await pending, { status: "state_changed" });
  assert.deepEqual(await x.snapshot(), before, "same revision changed value causes zero writes");
  x.setRow({ ...SYNTHETIC_PROFILE_FIXTURES.populated, imported_at: "2026-11-01T00:00:00.000Z", snapshot_revision: "changed-metadata" });
  assert.equal((await x.api.save({ token, canonicalValue: "" })).status, "committed", "same displayed value survives metadata revision change");
  const clear = await x.snapshot(); assert.equal(clear.profile[0]!.objective, null); assert.ok(clear.profile[0]!.objective_written_at);
  let fallbackReads = 0;
  const withoutFallback = x.store.forBrowserSession({ ...x.options, importedFallback: { read: async () => { fallbackReads++; throw new Error("hidden fallback must not be read"); } } });
  const clearedToken = await withoutFallback.issue("objective");
  assert.equal(clearedToken.baselineDigest, browserBaselineDigest({ persisted: { kind: "null" }, shownFallback: null }));
  assert.equal((await withoutFallback.save({ token: clearedToken, canonicalValue: "Written after clear" })).status, "committed");
  assert.equal(fallbackReads, 0);
});

test("U2A_BOUNDARY revoked sessions between precheck and lock cannot save, replay or read receipts", async () => {
  for (const operation of ["save", "replay", "status"] as const) {
    const x = await browserFixture(), token = await x.api.issue("objective");
    if (operation !== "save") assert.equal((await x.api.save({ token, canonicalValue: "Secret prior draft" })).status, "committed");
    const precheck = deferred(), resume = deferred(); let calls = 0;
    const api = x.store.forBrowserSession({ ...x.options, sessionLiveness: { read: async (client, session) => {
      const result = await readLiveLoginSessionPerson(client, session);
      if (++calls === 1) { precheck.resolve(); await resume.promise; }
      return result;
    } } });
    const unlock = await holdBrowserLock(x.id);
    const pending = operation === "status" ? api.receiptStatus(token) : api.save({ token, canonicalValue: operation === "save" ? "Never written" : "Secret prior draft" });
    await precheck.promise;
    await pool.query("UPDATE login_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [sessionHash(x.sessionToken)]);
    const before = await x.snapshot(); resume.resolve(); await unlock();
    assert.deepEqual(await pending, { status: "not_authorized" }, operation);
    assert.ok(calls >= 2, "session liveness checked inside the acquired lock");
    assert.deepEqual(await x.snapshot(), before);
  }
});

test("U2A_CLOCK issuance uses DB clock despite app skew and lock expiry uses wall clock", async () => {
  const x = await browserFixture();
  let seen: Date | undefined;
  const skewed = x.store.forBrowserSession({ ...x.options, tokens: {
    ...x.tokens,
    issue: (binding, baseline, now) => { seen = now; return x.tokens.issue(binding, baseline, now); },
  } });
  const dbBefore = await databaseNow();
  const token = await skewed.issue("objective");
  const dbAfter = await databaseNow();
  assert.ok(seen); assert.ok(Date.parse(token.issuedAt) >= dbBefore.getTime() && Date.parse(token.issuedAt) <= dbAfter.getTime());
  // Deliberately skew application Date construction; the store must use the SQL result.
  const realDate = globalThis.Date;
  class SkewedDate extends realDate { constructor(value?: string | number) { super(value === undefined ? realDate.now() + 1_000 : value); } }
  let skewToken: BrowserWriteToken;
  try { globalThis.Date = SkewedDate as DateConstructor; skewToken = await skewed.issue("objective"); }
  finally { globalThis.Date = realDate; }
  assert.equal((await skewed.save({ token: skewToken!, canonicalValue: "Fresh with app skew" })).status, "committed");
  const nearExpiry = await x.tokenAt(new Date((await databaseNow()).getTime() - 299_000));
  const lockEntered = deferred(), unlock = await holdBrowserLock(x.id);
  const api = new BrowserPostgresPersonProfileStore({ pool: interceptPool(async (sql, run) => {
    if (sql.includes("pg_advisory_xact_lock")) { const pending = run(); lockEntered.resolve(); return pending; }
    return run();
  }) }).forBrowserSession(x.options);
  const before = await x.snapshot(), pending = api.save({ token: nearExpiry, canonicalValue: "Expired during wait" });
  try {
    await lockEntered.promise;
    await pool.query("SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.05)", [nearExpiry.expiresAt]);
  } finally { await unlock(); }
  assert.deepEqual(await pending, { status: "expired" });
  assert.deepEqual(await x.snapshot(), before);
});

test("U2A_STATUS real session reader and status are read-only even for valid unspent tokens", async () => {
  let x!: Awaited<ReturnType<typeof browserFixture>>;
  await assert.doesNotReject(async () => { x = await browserFixture(); });
  let token!: BrowserWriteToken;
  await assert.doesNotReject(async () => { token = await x.api.issue("objective"); }, "SELECT-only liveness works in the read-only issue transaction");
  const expiredSession = randomUUID();
  await pool.query("INSERT INTO login_sessions(id,person_id,expires_at) VALUES($1,$2,clock_timestamp()-interval '1 second')", [sessionHash(expiredSession), x.id]);
  const before = await x.snapshot(), client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    assert.equal(await readLiveLoginSessionPerson(client, x.sessionToken), x.id);
    assert.equal(await readLiveLoginSessionPerson(client, expiredSession), undefined);
    assert.equal(await readLiveLoginSessionPerson(client, "unrecognized-session"), undefined);
    await client.query("COMMIT");
  } finally { client.release(); }
  const queries: string[] = [];
  const api = new BrowserPostgresPersonProfileStore({ pool: interceptPool(async (sql, run) => { queries.push(sql); return run(); }) }).forBrowserSession(x.options);
  assert.deepEqual(await api.receiptStatus(token), { status: "not_found" });
  assert.ok(queries.includes("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY"));
  assert.ok(queries.every(sql => !/\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)), "status executes no write statement or session housekeeping");
  assert.deepEqual(await x.snapshot(), before);
  assert.equal((await api.save({ token, canonicalValue: "Status did not spend token" })).status, "committed");
  const after = await x.snapshot(); assert.equal(after.audit.length, 1);
  assert.equal((await api.receiptStatus(token)).status, "committed");
  assert.deepEqual(await x.snapshot(), after);
});

test("U2A_UNKNOWN pre-COMMIT rollback retries once; dropped COMMIT response reconciles one durable result", async () => {
  const x = await browserFixture(), token = await x.api.issue("objective"), before = await x.snapshot();
  let failBefore = true;
  const faulted = new BrowserPostgresPersonProfileStore({ pool: interceptPool(async (sql, run) => {
    if (failBefore && sql.includes("INSERT INTO authorization_mutation_audit")) { failBefore = false; throw new Error("injected pre-COMMIT transport failure"); }
    return run();
  }) }).forBrowserSession(x.options);
  await assert.rejects(faulted.save({ token, canonicalValue: "Retry once" }), error => error instanceof PersonProfileBrowserRetryableError);
  assert.deepEqual(await x.snapshot(), before);
  assert.deepEqual(await x.api.receiptStatus(token), { status: "not_found" });
  assert.equal((await faulted.save({ token, canonicalValue: "Retry once" })).status, "committed");
  assert.equal((await x.snapshot()).audit.length, 1);
  const next = await x.api.issue("objective"); let dropCommit = true;
  const dropped = new BrowserPostgresPersonProfileStore({ pool: interceptPool(async (sql, run) => {
    const result = await run();
    if (dropCommit && sql === "COMMIT") { dropCommit = false; throw new Error("injected lost COMMIT response"); }
    return result;
  }) }).forBrowserSession(x.options);
  assert.deepEqual(await dropped.save({ token: next, canonicalValue: "Durable despite response loss" }), { status: "unknown" });
  const resolved = await x.api.receiptStatus(next); assert.equal(resolved.status, "committed");
  const after = await x.snapshot(); assert.equal(after.audit.length, 2); assert.equal(after.profile[0]!.objective, "Durable despite response loss");
  const replay = await x.api.save({ token: next, canonicalValue: "Durable despite response loss" });
  assert.equal(replay.status, "already_committed");
  if ("receipt" in resolved && "receipt" in replay) assert.deepEqual(resolved.receipt, replay.receipt);
  assert.deepEqual(await x.snapshot(), after);
});

test("U2A_NAMESPACE browser and legacy tokens with the same raw id never collide", async () => {
  const x = await browserFixture(), token = await x.api.issue("objective");
  const legacyRef = createHash("sha256").update("studenthub:safe-write-token-ref:v1\0").update(token.tokenId).digest("hex");
  assert.notEqual(legacyRef, token.tokenRef);
  const legacy = await x.store.forPrincipal(x.id).commit({ principalRef: token.principalRef, personRef: token.personRef,
    field: "intro", expectedBefore: null, value: "Legacy intro", tokenId: token.tokenId, changeSetDigest: "c".repeat(64),
    receipt: { contractVersion: "3.0.0", receiptRef: requestAuditRef(randomUUID()), personRef: token.personRef, principalRef: token.principalRef,
      fields: ["intro"], changeSetDigest: "c".repeat(64), committedAt: (await databaseNow()).toISOString() } });
  assert.ok(legacy.ok);
  await assert.doesNotReject(async () => {
    assert.equal((await x.api.save({ token, canonicalValue: "Browser objective" })).status, "committed");
  }, "legacy token namespace does not block browser write");
  const state = await x.snapshot(); assert.equal(state.audit.length, 2);
  assert.deepEqual(state.audit.map(row => row.after_summary.tokenRef).sort(), [legacyRef, token.tokenRef].sort());
});

// Serial mutation run against this exact emitted suite and real Postgres.
// Child processes select a named assertion; source is always restored before exit.
if (process.env.PROFILE_BROWSER_MUTANTS !== "0") test("U2A_MUTANTS every browser boundary mutant dies at its named assertion", async () => {
  const storeModule = new URL("../src/person-profile-store.js", import.meta.url);
  const loginModule = new URL("../src/postgres-login-store.js", import.meta.url);
  const suite = fileURLToPath(import.meta.url);
  const mutations = [
    { name: "dependent mother clear removed", assertion: "U2A_ORIGIN", module: storeModule,
      from: 'if (field === "nationality" && selected.code === "KW")',
      to: 'if (false)' },
    { name: "expiry before receipt", assertion: "U2A_REPLAY", module: storeModule,
      from: "const receipt = await this.#findBrowserReceipt(client, options, token);",
      to: 'if (browserFirstWriteExpired(token, (await client.query("SELECT clock_timestamp() AS now")).rows[0].now)) throw new BrowserRefusal("expired"); const receipt = await this.#findBrowserReceipt(client, options, token);' },
    { name: "transaction start rather than wall clock", assertion: "U2A_CLOCK", module: storeModule,
      from: 'if (browserFirstWriteExpired(token, now))',
      to: 'if (browserFirstWriteExpired(token, (await client.query("SELECT now() AS now")).rows[0].now))' },
    { name: "legacy browser token namespace", assertion: "U2A_NAMESPACE", module: storeModule,
      from: "fields: [field], committedAt, tokenRef: token.tokenRef",
      to: "fields: [field], committedAt, tokenRef: tokenRef(token.tokenId)" },
    { name: "status spends token", assertion: "U2A_STATUS", module: storeModule,
      from: "const receipt = await this.#findBrowserReceipt(client, options, verified.token);",
      to: `await client.query("INSERT INTO authorization_mutation_audit(request_ref,actor_principal_ref,operation,target_principal_ref,target_org_refs,before_summary,after_summary) VALUES($1,$2,$3,$2,'{}',$4::jsonb,$5::jsonb)", [randomBytes(32).toString("hex"), verified.token.principalRef, SAFE_WRITE_OPERATION, JSON.stringify({valuePresent:false}), JSON.stringify({contractVersion:BROWSER_WRITE_VERSION,personRef:verified.token.personRef,changeSetDigest:"0".repeat(64),fields:[verified.token.field],committedAt:new Date().toISOString(),tokenRef:verified.token.tokenRef})]); const receipt = await this.#findBrowserReceipt(client, options, verified.token);` },
    { name: "liveness deletes expired sessions", assertion: "U2A_STATUS", module: loginModule,
      from: "SELECT person_id FROM login_sessions WHERE id = $1 AND expires_at > clock_timestamp()",
      to: "WITH expired AS (DELETE FROM login_sessions WHERE expires_at <= clock_timestamp()) SELECT person_id FROM login_sessions WHERE id = $1 AND expires_at > clock_timestamp()" },
    { name: "fallback compares revision only", assertion: "U2A_FALLBACK", module: storeModule,
      from: 'value: row.value }, shownFallback };',
      to: 'value: row.value }, shownFallback: shownFallback === null ? null : { ...shownFallback, sourceRef: "0".repeat(64), valueDigest: "0".repeat(64) } };' },
    { name: "pre-COMMIT failure is unknown", assertion: "U2A_UNKNOWN", module: storeModule,
      from: "else\n                throw new PersonProfileBrowserRetryableError({ cause: error });",
      to: 'else return { status: "unknown" };' },
  ];
  for (const mutant of mutations) {
    const original = await readFile(mutant.module, "utf8");
    assert.equal(original.split(mutant.from).length - 1, 1, `${mutant.name}: unique mutation site`);
    try {
      await writeFile(mutant.module, original.replace(mutant.from, mutant.to));
      const childEnv = { ...process.env, PROFILE_BROWSER_MUTANTS: "0" };
      delete (childEnv as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ["--test", `--test-name-pattern=^${mutant.assertion} `, suite], {
        encoding: "utf8", timeout: 45_000, env: childEnv,
      });
      const output = result.stdout + result.stderr;
      assert.equal(result.signal, null, `${mutant.name}: must fail an assertion, not time out\n${output}`);
      assert.notEqual(result.status, 0, `${mutant.name}: survived\n${output}`);
      assert.match(output, new RegExp(`not ok \\d+ - ${mutant.assertion} `), `${mutant.name}\n${output}`);
      assert.match(output, /ERR_ASSERTION/, `${mutant.name}: must fail its named assertion\n${output}`);
      console.log(`Killed ${mutant.name} at ${mutant.assertion}`);
    } finally { await writeFile(mutant.module, original); }
  }
});

test("U2A_BASELINE browser persisted edits invalidate older tokens and SQL CHECK rollback leaves token unspent", async () => {
  const x = await browserFixture(), stale = await x.api.issue("objective"), winner = await x.api.issue("objective");
  assert.equal((await x.api.save({ token: winner, canonicalValue: "Changed persisted value" })).status, "committed");
  const before = await x.snapshot();
  assert.deepEqual(await x.api.save({ token: stale, canonicalValue: "Stale overwrite" }), { status: "state_changed" });
  assert.deepEqual(await x.snapshot(), before);
  const retry = await x.api.issue("objective");
  await assert.rejects(x.api.save({ token: retry, canonicalValue: "Invalid  doubled spaces" }), error => error instanceof PersonProfileBrowserRetryableError);
  assert.deepEqual(await x.snapshot(), before, "SQL CHECK violation rolls back profile and audit together");
  assert.deepEqual(await x.api.receiptStatus(retry), { status: "not_found" });
  assert.equal((await x.api.save({ token: retry, canonicalValue: "Corrected valid value" })).status, "committed");
});

test("U2A_VERIFY forged tokens are refused before any authorization or fallback read", async () => {
  const x = await browserFixture(), token = await x.api.issue("objective"), before = await x.snapshot();
  let reads = 0;
  const api = x.store.forBrowserSession({ ...x.options,
    sessionLiveness: { read: async () => { reads++; throw new Error("invalid token must not authorize"); } },
    importedFallback: { read: async () => { reads++; throw new Error("invalid token must not read fallback"); } },
  });
  for (const forged of [{ ...token, mac: "A".repeat(43) }, { ...token, personRef: "0".repeat(64) }, { ...token, normalizationVersion: "other-version" }]) {
    assert.deepEqual(await api.save({ token: forged, canonicalValue: "Draft" }), { status: "not_authorized" });
    assert.deepEqual(await api.receiptStatus(forged), { status: "not_authorized" });
  }
  assert.equal(reads, 0);
  assert.deepEqual(await x.snapshot(), before);
});

test("U2A_ROLLBACK non-token unique violation is a confirmed rollback with no spent token", async () => {
  const x = await browserFixture(), holder = await browserFixture();
  const phone = `+44${BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString().slice(0, 11)}`;
  await pool.query("INSERT INTO person_profiles(principal_id,phone,phone_written_at) VALUES($1,$2,clock_timestamp())", [holder.id, phone]);
  const token = await x.api.issue("phone"), before = await x.snapshot();
  await assert.rejects(x.api.save({ token, canonicalValue: phone }), error => error instanceof PersonProfileBrowserRetryableError);
  assert.deepEqual(await x.snapshot(), before);
  assert.deepEqual(await x.api.receiptStatus(token), { status: "not_found" });
  assert.equal((await x.api.save({ token, canonicalValue: `+33${phone.slice(3)}` })).status, "committed");
  assert.equal((await x.snapshot()).audit.length, 1);
});


test("U2A_CANON_STORE profile receipts have one canonical string representation", async () => {
  const x = await browserFixture(), token = await x.api.issue("objective"), before = await x.snapshot();
  for (const canonicalValue of [null, false]) {
    await assert.rejects(x.api.save({ token, canonicalValue }), TypeError);
    assert.deepEqual(await x.snapshot(), before);
  }
  const result = await x.api.save({ token, canonicalValue: "" });
  assert.equal(result.status, "committed");
  if (!("receipt" in result)) return;
  assert.equal(result.receipt.changeSetDigest, browserChangeSetDigest(token, ""));
  assert.deepEqual(await x.api.save({ token, canonicalValue: null }), { status: "token_payload_mismatch" });
  const choice = await x.api.issue("drivingLicence");
  const saved = await x.api.save({ token: choice, canonicalValue: "false" });
  assert.equal(saved.status, "committed");
  if (!("receipt" in saved)) return;
  const current = (await pool.query("SELECT driving_licence::text AS value FROM person_profiles WHERE principal_id=$1", [x.id])).rows[0]!.value;
  assert.equal(saved.receipt.changeSetDigest, browserChangeSetDigest(choice, current));
});


test("U2A_PAYLOAD snapshot cannot change between digest and locked write", async () => {
  const x = await browserFixture(), token = await x.api.issue("objective");
  const locked = deferred(), unlock = await holdBrowserLock(x.id);
  const api = new BrowserPostgresPersonProfileStore({ pool: interceptPool(async (sql, run) => {
    if (sql.includes("pg_advisory_xact_lock")) { const pending = run(); locked.resolve(); return pending; }
    return run();
  }) }).forBrowserSession(x.options);
  const input = { token, canonicalValue: "Payload A" };
  const pending = api.save(input);
  try { await locked.promise; input.canonicalValue = "Payload B"; } finally { await unlock(); }
  const result = await pending;
  assert.equal(result.status, "committed");
  if (!("receipt" in result)) return;
  assert.equal((await x.snapshot()).profile[0]!.objective, "Payload A");
  assert.equal(result.receipt.changeSetDigest, browserChangeSetDigest(token, "Payload A"));
});

test("U2A_NOOP fresh no-op operation gets one receipt and snapshots session configuration", async () => {
  const x = await browserFixture();
  const mutableOptions = { ...x.options };
  const api = x.store.forBrowserSession(mutableOptions);
  mutableOptions.principalId = "changed-after-construction";
  mutableOptions.sessionToken = "changed-after-construction";
  mutableOptions.normalizationVersion = "changed-after-construction";
  const first = await api.issue("objective");
  assert.equal(first.principalRef, safeWritePrincipalRef(x.id));
  assert.equal(first.normalizationVersion, x.options.normalizationVersion);
  const a = await api.save({ token: first, canonicalValue: "Unchanged objective" });
  assert.equal(a.status, "committed");
  const token = await api.issue("objective");
  const b = await api.save({ token, canonicalValue: "Unchanged objective" });
  assert.equal(b.status, "committed");
  if (!("receipt" in a) || !("receipt" in b)) return;
  assert.notEqual(a.receipt.receiptRef, b.receipt.receiptRef);
  assert.equal(a.receipt.changeSetDigest, b.receipt.changeSetDigest);
  assert.equal((await x.snapshot()).audit.length, 2);
  const before = await x.snapshot();
  assert.deepEqual(await api.save({ token, canonicalValue: "Unchanged objective" }), { status: "already_committed", receipt: b.receipt });
  assert.deepEqual(await x.snapshot(), before);
});


test("U2A_ORIGIN nationality save atomically clears dependent mother answer and stales its prior token", async () => {
  const x = await browserFixture(), country = randomUUID(), actor = "a".repeat(64);
  await pool.query(`INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,code,status,created_by_ref,updated_by_ref,created_at,updated_at)
    VALUES($1,'country',$2,$2,'KW','active',$3,$3,clock_timestamp(),clock_timestamp())`, [country, `browser kuwait ${country}`, actor]);
  const mother = await x.api.issue("kuwaitiMother");
  assert.equal((await x.api.save({ token: mother, canonicalValue: "true" })).status, "committed");
  const staleMother = await x.api.issue("kuwaitiMother");
  const nationality = await x.api.issue("nationality");
  const before = await x.snapshot();
  await assert.doesNotReject(async () => {
    const result = await x.api.save({ token: nationality, canonicalValue: country });
    assert.equal(result.status, "committed");
    if (!("receipt" in result)) return;
    assert.deepEqual(result.receipt.fields, ["nationality"]);
    assert.equal(result.receipt.changeSetDigest, browserChangeSetDigest(nationality, country));
  }, "nationality save preserves the origin invariant through its one allowed dependent clear");
  const after = await x.snapshot();
  assert.equal(after.profile[0]!.nationality_id, country);
  assert.equal(after.profile[0]!.kuwaiti_mother, null);
  assert.equal(after.profile[0]!.kuwaiti_mother_written_at, null);
  assert.equal(after.audit.length, before.audit.length + 1);
  const added = after.audit.filter(row => !before.audit.some(prior => prior.request_ref === row.request_ref));
  assert.equal(added.length, 1);
  assert.deepEqual(added[0]!.after_summary.fields, ["nationality"]);
  assert.deepEqual(await x.api.save({ token: staleMother, canonicalValue: "false" }), { status: "state_changed" });
  assert.deepEqual(await x.snapshot(), after, "stale mother token writes nothing");
});
