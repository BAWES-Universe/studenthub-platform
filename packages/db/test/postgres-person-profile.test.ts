import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresPersonProfileStore, PostgresSafeWriteStore, personRecordRef, principalAuditRef, requestAuditRef, runMigrations, safeWritePrincipalRef } from "@studenthub/db";
import { InMemoryApprovedProfileAdapter, OwnProfileRepository, SHU372_RULES, SYNTHETIC_PROFILE_FIXTURES, createPersonSelfEdit } from "@studenthub/profile";
import { profileDocument, type BrowserLoginApplication } from "../../../apps/gateway/src/web-ui.js";

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

test("SHU415_CATALOGUE choices omit deleted countries and universities", async () => {
  const store = new PostgresPersonProfileStore({ pool }), ref = "a".repeat(64);
  const insert = async (type: "country" | "university", status: "active" | "deleted", name: string, code?: string) => {
    const id = randomUUID();
    await pool.query(`INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,code,status,created_by_ref,updated_by_ref,created_at,updated_at,deleted_at)
      VALUES($1,$2,$3,$3,$4,$5,$6,$6,now(),now(),$7)`, [id,type,name,code ?? null,status,ref,status === "deleted" ? new Date() : null]);
    return id;
  };
  const activeCountry = await insert("country", "active", `Active-${randomUUID()}`), deletedCountry = await insert("country", "deleted", `Deleted-${randomUUID()}`);
  const activeUniversity = await insert("university", "active", `Active-${randomUUID()}`), deletedUniversity = await insert("university", "deleted", `Deleted-${randomUUID()}`);
  const choices = await store.profileChoices();
  assert.equal(choices.countries.some(choice => choice.id === activeCountry), true);
  assert.equal(choices.universities.some(choice => choice.id === activeUniversity), true);
  assert.equal(choices.countries.some(choice => choice.id === deletedCountry), false);
  assert.equal(choices.universities.some(choice => choice.id === deletedUniversity), false);
});

test("SHU415_WRITE Postgres writes origin fields twice, resolves labels, and refuses the Kuwaiti combination", async () => {
  const id = `shu415-${randomUUID()}`, authz = new PostgresAuthzStore(pool), ref = "b".repeat(64);
  await authz.registerPrincipal(createPrincipal({ id, email: `${id}@example.invalid`, pbuuids: [] }));
  const catalogue = async (type: "country" | "university", name: string, code?: string) => { const itemId=randomUUID(); await pool.query(`INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,code,status,created_by_ref,updated_by_ref,created_at,updated_at) VALUES($1,$2,$3,$3,$4,'active',$5,$5,now(),now())`,[itemId,type,name,code??null,ref]); return itemId; };
  const country = await catalogue("country", "Canadian"), kuwait = await catalogue("country", "Kuwaiti", "KW"), university = await catalogue("university", "Test University");
  const store = new PostgresPersonProfileStore({ pool }), writer = () => createPersonSelfEdit({ store: store.forPrincipal(id), secret: "s".repeat(32) });
  const write = async (field: "nationality" | "university" | "kuwaitiMother", value: string) => { const principalRef=safeWritePrincipalRef(id),change={personRef:personRecordRef(id),field,value};const preview=await writer().preview({principalRef,change});assert.ok(preview.ok);return preview.ok?writer().confirm({principalRef,change,token:preview.token}):preview; };
  for (const [field, values] of [["nationality",[country,country]],["university",[university,university]],["kuwaitiMother",["true","false"]]] as const) for (const value of values) assert.equal((await write(field,String(value))).ok,true);
  assert.equal((await write("kuwaitiMother","true")).ok,true);
  assert.deepEqual(await write("nationality",kuwait),{ok:false,reason:"invalid_value"});
  const preferences = await store.readOwnPreferences(id) as Record<string,{value:unknown}>;
  assert.equal(preferences.nationality!.value,"Canadian"); assert.equal(preferences.university!.value,"Test University"); assert.equal(preferences.kuwaitiMother!.value,"true");
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
