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
  for (const [field, rule] of Object.entries(SHU372_RULES)) {
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

test("SHU373_WRITE all seven fields write twice, booleans stay textual for safe-write, and Kuwaiti mother clears to NULL",async()=>{const id=`shu373-${randomUUID()}`,authz=new PostgresAuthzStore(pool);await authz.registerPrincipal(createPrincipal({id,email:`${id}@example.invalid`,pbuuids:[]}));const actor="a".repeat(64),country1=randomUUID(),country2=randomUUID(),university=randomUUID();for(const[item,type,name,code]of[[country1,"country","Jordan","JO"],[country2,"country","Lebanon","LB"],[university,"university","Kuwait University",null]]as const)await pool.query(`INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,code,status,created_by_ref,updated_by_ref,created_at,updated_at) VALUES($1,$2,$3,lower($3),$4,'active',$5,$5,clock_timestamp(),clock_timestamp())`,[item,type,name,code,actor]);const store=new PostgresPersonProfileStore({pool}),writer=()=>createPersonSelfEdit({store:store.forPrincipal(id),secret:"s".repeat(32),clock:{now:()=>new Date("2026-10-30T12:00:00.000Z")}});const write=async(field:any,value:string)=>{const request={principalRef:safeWritePrincipalRef(id),change:{personRef:personRecordRef(id),field,value}},preview=await writer().preview(request);assert.ok(preview.ok,`${field} preview`);if(preview.ok)assert.ok((await writer().confirm({...request,token:preview.token})).ok,`${field} confirm`)};for(const[field,a,b]of[["gender","male","female"],["birthDate","2000-01-01","2000-01-02"],["nationality",country1,country2],["university",university,""],["drivingLicence","true","false"],["kuwaitiMother","true","false"],["jobSearchStatus","active","not_looking"]]){await write(field,a);await write(field,b)}await write("kuwaitiMother","");const row=(await pool.query("SELECT birth_date::text birth_date,driving_licence::text driving_licence,kuwaiti_mother::text kuwaiti_mother,job_search_status,job_search_status_written_at FROM person_profiles WHERE principal_id=$1",[id])).rows[0];assert.deepEqual([row.birth_date,row.driving_licence,row.kuwaiti_mother,row.job_search_status],["2000-01-02","false",null,"not_looking"]);assert.ok(row.job_search_status_written_at instanceof Date)});

test("SHU373_CATALOGUE reads active countries and universities only in one catalogue query",async()=>{const actor="b".repeat(64),active=randomUUID(),deleted=randomUUID();await pool.query(`INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,code,status,created_by_ref,updated_by_ref,created_at,updated_at,deleted_at) VALUES($1,'country','Test Active','test active','TA','active',$3,$3,clock_timestamp(),clock_timestamp(),NULL),($2,'university','Test Deleted','test deleted',NULL,'deleted',$3,$3,clock_timestamp(),clock_timestamp(),clock_timestamp())`,[active,deleted,actor]);const choices=await new PostgresPersonProfileStore({pool}).readProfileChoices();assert.ok(choices.countries.some(x=>x.id===active&&x.name==="Test Active"));assert.ok(!choices.universities.some(x=>x.id===deleted))});

test("SHU373_CATALOGUE deleted and unknown choices are refused without storing, and the database refuses Kuwaiti-mother status",async()=>{const id=`shu373-catalogue-${randomUUID()}`,authz=new PostgresAuthzStore(pool);await authz.registerPrincipal(createPrincipal({id,email:`${id}@example.invalid`,pbuuids:[]}));const actor="c".repeat(64),deleted=randomUUID(),kuwait=randomUUID();await pool.query(`INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,code,status,created_by_ref,updated_by_ref,created_at,updated_at,deleted_at) VALUES($1,'country','Deleted country','deleted country','DC','deleted',$3,$3,clock_timestamp(),clock_timestamp(),clock_timestamp()),($2,'country','Kuwait','kuwait','KW','active',$3,$3,clock_timestamp(),clock_timestamp(),NULL)`,[deleted,kuwait,actor]);const store=new PostgresPersonProfileStore({pool}),writer=createPersonSelfEdit({store:store.forPrincipal(id),secret:"s".repeat(32)});for(const value of[deleted,randomUUID()]){const change={personRef:personRecordRef(id),field:"nationality" as const,value},preview=await writer.preview({principalRef:safeWritePrincipalRef(id),change});assert.ok(preview.ok);if(preview.ok)assert.deepEqual(await writer.confirm({principalRef:safeWritePrincipalRef(id),change,token:preview.token}),{ok:false,reason:"invalid_value"})}assert.equal((await pool.query("SELECT nationality_id FROM person_profiles WHERE principal_id=$1",[id])).rows[0]?.nationality_id??null,null);await pool.query("INSERT INTO person_profiles(principal_id,nationality_id,nationality_written_at) VALUES($1,$2,clock_timestamp())",[id,kuwait]);await assert.rejects(pool.query("UPDATE person_profiles SET kuwaiti_mother=true,kuwaiti_mother_written_at=clock_timestamp() WHERE principal_id=$1",[id]),(error:any)=>error.code==="23514");assert.equal((await pool.query("SELECT kuwaiti_mother FROM person_profiles WHERE principal_id=$1",[id])).rows[0]?.kuwaiti_mother,null)});

test("SHU373_WRITE changing nationality to Kuwait clears Kuwaiti mother through the writer",async()=>{const id=`shu373-kw-${randomUUID()}`,authz=new PostgresAuthzStore(pool);await authz.registerPrincipal(createPrincipal({id,email:`${id}@example.invalid`,pbuuids:[]}));const actor="d".repeat(64),jordan=randomUUID(),kuwait=randomUUID();for(const[item,name,code]of[[jordan,"Jordan","JO"],[kuwait,"Kuwait","KW"]])await pool.query(`INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,code,status,created_by_ref,updated_by_ref,created_at,updated_at) VALUES($1,'country',$2,lower($2),$3,'active',$4,$4,clock_timestamp(),clock_timestamp())`,[item,name,code,actor]);const store=new PostgresPersonProfileStore({pool}),writer=createPersonSelfEdit({store:store.forPrincipal(id),secret:"s".repeat(32)});const write=async(field:"nationality"|"kuwaitiMother",value:string)=>{const request={principalRef:safeWritePrincipalRef(id),change:{personRef:personRecordRef(id),field,value}},preview=await writer.preview(request);assert.ok(preview.ok);if(preview.ok)assert.ok((await writer.confirm({...request,token:preview.token})).ok)};await write("nationality",jordan);await write("kuwaitiMother","true");await write("nationality",kuwait);const row=(await pool.query("SELECT kuwaiti_mother,kuwaiti_mother_written_at FROM person_profiles WHERE principal_id=$1",[id])).rows[0];assert.equal(row.kuwaiti_mother,null);assert.equal(row.kuwaiti_mother_written_at,null);assert.equal((await store.readOwnPreferences(id))?.kuwaitiMother,undefined)});
