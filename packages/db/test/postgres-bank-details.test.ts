import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import {
  acceptAnyBankDetailsValue, BANK_DETAILS_FIELD, bankDetailsRecordRef, bankDetailsValue,
  buildBankDetailsWrite, catalogueBankDetailsCheck, type BankDetails,
} from "@studenthub/pay-contracts";
import {
  BANK_DETAILS_OPERATION, principalAuditRef, PostgresAuthzStore, PostgresBankDetailsStore, PostgresFinanceReferenceResolver,
  PostgresPayContractStore, PostgresProfileRecordStore, PostgresSafeWriteStore, LANGUAGE_FIELD, personRecordRef, runMigrations,
} from "@studenthub/db";

// Synthetic fixtures only: made-up people, a made-up bank and a checksum-valid test IBAN.
const DB_URL = process.env.DATABASE_URL ?? "";
const KEY = "shu182-bank-details-test-secret-at-least-thirty-two-bytes";
const ORG = `shu182-bank-${randomUUID()}`;
const IBAN = "KW81CBKU0000000000001234560101";
const NAME = "Synthetic Beneficiary";
const FIXED = new Date("2026-10-08T12:00:00.000Z");
let pool: pg.Pool;
let authz: PostgresAuthzStore;
let store: PostgresBankDetailsStore;
let banks: PostgresFinanceReferenceResolver;

before(async () => {
  if (!DB_URL) throw new Error("DATABASE_URL is required for PostgreSQL bank-details tests");
  pool = new pg.Pool({ connectionString: DB_URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: ORG, name: "SHU-182 synthetic bank-details org" }));
  store = new PostgresBankDetailsStore({ pool });
  banks = new PostgresFinanceReferenceResolver(pool);
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

async function person(role = "candidate"): Promise<string> {
  const id = `shu182-bank-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  await authz.grantMany(id, [{ orgId: ORG, role: role as "candidate" }]);
  return id;
}

function rig(id: string, check = catalogueBankDetailsCheck(banks)) {
  const writer = buildBankDetailsWrite({ store: store.forPrincipal(id), secret: KEY, check });
  const change = (details: BankDetails) => ({
    personRef: bankDetailsRecordRef(id), field: BANK_DETAILS_FIELD, value: bankDetailsValue(details),
  });
  const principalRef = principalAuditRef(id);
  async function write(details: BankDetails) {
    const preview = await writer.preview({ principalRef, change: change(details) });
    assert.ok(preview.ok, JSON.stringify(preview));
    return writer.confirm({ principalRef, change: change(details), token: preview.token });
  }
  return { writer, change, principalRef, write };
}

/** A commit straight to the store, as a confirm racing another writer would reach it. */
function directCommit(id: string, expectedBefore: string | null, details: BankDetails, tokenId = randomUUID(), receiptRef = randomUUID().replaceAll("-", "").padEnd(64, "0")) {
  const principalRef = principalAuditRef(id);
  return store.forPrincipal(id).commit({
    personRef: bankDetailsRecordRef(id), principalRef, tokenId, field: BANK_DETAILS_FIELD,
    expectedBefore, value: bankDetailsValue(details), changeSetDigest: "b".repeat(64),
    receipt: { contractVersion: "3.0.0", receiptRef, personRef: bankDetailsRecordRef(id), principalRef,
      changeSetDigest: "b".repeat(64), fields: [BANK_DETAILS_FIELD], committedAt: FIXED.toISOString() },
  });
}

async function stored(id: string) {
  const { rows } = await pool.query("SELECT bank_id::text, iban, beneficiary_name FROM candidate_bank_details WHERE principal_id = $1", [id]);
  return rows[0];
}

test("SHU182_BANK_PG_WRITE confirm stores the triple and a self-authored, value-free receipt", async () => {
  const id = await person();
  const bankId = await catalogueItem("bank");
  const done = await rig(id).write({ bankId, iban: IBAN, beneficiaryName: NAME });
  assert.ok(done.ok, JSON.stringify(done));
  assert.deepEqual(await stored(id), { bank_id: bankId, iban: IBAN, beneficiary_name: NAME });
  const { rows } = await pool.query(
    "SELECT operation, actor_principal_ref, target_principal_ref, target_org_refs, before_summary, after_summary FROM authorization_mutation_audit WHERE request_ref = $1",
    [done.receipt.receiptRef]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operation, BANK_DETAILS_OPERATION);
  assert.equal(rows[0].actor_principal_ref, principalAuditRef(id));
  assert.equal(rows[0].target_principal_ref, principalAuditRef(id));
  assert.deepEqual(rows[0].target_org_refs, []);
  assert.deepEqual(rows[0].before_summary, { valuePresent: false });
  assert.deepEqual(rows[0].after_summary.fields, [BANK_DETAILS_FIELD]);
  const ledger = JSON.stringify(rows[0]);
  for (const secret of [IBAN, NAME, bankId, id]) assert.ok(!ledger.includes(secret), `ledger carries ${secret}`);
  assert.deepEqual(await store.readReceipt(id, done.receipt.receiptRef), done.receipt);
  // Another person gets no receipt at all: not an error, which would tell them the reference exists.
  assert.equal(await store.readReceipt(await person(), done.receipt.receiptRef).catch(() => "threw"), null, "another person cannot read it");

  // A second write replaces the triple and records that a value was present.
  const otherBank = await catalogueItem("bank");
  const again = await rig(id).write({ bankId: otherBank, iban: "GB82WEST12345698765432", beneficiaryName: NAME });
  assert.ok(again.ok);
  assert.deepEqual(await stored(id), { bank_id: otherBank, iban: "GB82WEST12345698765432", beneficiary_name: NAME });
  const second = await pool.query("SELECT before_summary FROM authorization_mutation_audit WHERE request_ref = $1", [again.receipt.receiptRef]);
  assert.deepEqual(second.rows[0].before_summary, { valuePresent: true });
});

test("SHU182_BANK_PG_OWNER only a current candidate may write, and revocation before commit stops it", async () => {
  const bankId = await catalogueItem("bank");
  const details = { bankId, iban: IBAN, beneficiaryName: NAME };
  const staff = await person("staff");
  const s = rig(staff);
  assert.deepEqual(await s.writer.preview({ principalRef: s.principalRef, change: s.change(details) }), { ok: false, reason: "not_own_record" });

  const id = await person();
  const c = rig(id);
  const preview = await c.writer.preview({ principalRef: c.principalRef, change: c.change(details) });
  assert.ok(preview.ok);
  await authz.revokeMany(id, [{ orgId: ORG, role: "candidate" }]);
  assert.deepEqual(await c.writer.confirm({ principalRef: c.principalRef, change: c.change(details), token: preview.token }),
    { ok: false, reason: "not_own_record" });
  // The store re-checks inside its own transaction too, not only through the contract's pre-read.
  assert.deepEqual(await directCommit(id, null, details), { ok: false, reason: "not_own_record" });
  assert.equal(await stored(id), undefined);
});

test("SHU182_BANK_PG_BANK_AT_COMMIT a bank retired after the confirm's check, or a non-bank item, is not stored", async () => {
  const id = await person();
  const bankId = await catalogueItem("bank");
  // The builder's own check is bypassed here so only the store's in-transaction check stands.
  const x = rig(id, acceptAnyBankDetailsValue);
  const details = { bankId, iban: IBAN, beneficiaryName: NAME };
  const preview = await x.writer.preview({ principalRef: x.principalRef, change: x.change(details) });
  assert.ok(preview.ok);
  await pool.query("UPDATE catalogue_items SET status = 'deleted', deleted_at = $2 WHERE id = $1", [bankId, FIXED]);
  assert.deepEqual(await x.writer.confirm({ principalRef: x.principalRef, change: x.change(details), token: preview.token }),
    { ok: false, reason: "state_changed" });
  const currency = await catalogueItem("currency");
  const notBank = { bankId: currency, iban: IBAN, beneficiaryName: NAME };
  const p2 = await x.writer.preview({ principalRef: x.principalRef, change: x.change(notBank) });
  assert.ok(p2.ok);
  assert.deepEqual(await x.writer.confirm({ principalRef: x.principalRef, change: x.change(notBank), token: p2.token }),
    { ok: false, reason: "state_changed" });
  assert.equal(await stored(id), undefined);
  // And through the production check, the same currency id is refused before any token is issued.
  const real = rig(id);
  assert.deepEqual(await real.writer.preview({ principalRef: real.principalRef, change: real.change(notBank) }), { ok: false, reason: "invalid_value" });
});

test("SHU182_BANK_PG_RACE two confirms of one token store once and report token_already_used", async () => {
  const id = await person();
  const bankId = await catalogueItem("bank");
  const details = { bankId, iban: IBAN, beneficiaryName: NAME };
  // Store the value first so the raced change is a no-op. Either unique index may answer the loser
  // (two confirms can share a committedAt); the direct commits below pin the token index itself.
  assert.ok((await rig(id).write(details)).ok);
  const a = rig(id), b = rig(id);
  const preview = await a.writer.preview({ principalRef: a.principalRef, change: a.change(details) });
  assert.ok(preview.ok);
  const results = await Promise.all([a, b].map((x) => x.writer.confirm({ principalRef: x.principalRef, change: x.change(details), token: preview.token })));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => !r.ok && r.reason === "token_already_used").length, 1, JSON.stringify(results));
  // The spent token alone refuses a second commit, whatever receipt reference it brings.
  const tokenId = randomUUID();
  const current = bankDetailsValue(details);
  assert.deepEqual(await directCommit(id, current, details, tokenId), { ok: true });
  assert.deepEqual(await directCommit(id, current, details, tokenId), { ok: false, reason: "token_already_used" });
});

test("SHU182_BANK_PG_STALE a value changed after the preview is not overwritten", async () => {
  const id = await person();
  const bankId = await catalogueItem("bank");
  const x = rig(id);
  const details = { bankId, iban: IBAN, beneficiaryName: NAME };
  const preview = await x.writer.preview({ principalRef: x.principalRef, change: x.change(details) });
  assert.ok(preview.ok);
  await pool.query("INSERT INTO candidate_bank_details (principal_id, bank_id, iban, beneficiary_name) VALUES ($1, $2, $3, $4)",
    [id, bankId, "GB82WEST12345698765432", NAME]);
  // This refusal comes from the contract's own pre-read; the direct commit below pins the store's compare.
  assert.deepEqual(await x.writer.confirm({ principalRef: x.principalRef, change: x.change(details), token: preview.token }),
    { ok: false, reason: "state_changed" });
  assert.equal((await stored(id)).iban, "GB82WEST12345698765432");
  // The compare is the store's own: a commit expecting no value does not overwrite one that landed.
  assert.deepEqual(await directCommit(id, null, details), { ok: false, reason: "state_changed" });
  assert.equal((await stored(id)).iban, "GB82WEST12345698765432");
});

test("SHU182_BANK_PG_SCHEMA the table and the ledger refuse malformed rows from any writer", async () => {
  const id = await person();
  const bankId = await catalogueItem("bank");
  for (const [iban, name] of [["kw81cbku0000000000001234560101", NAME], [IBAN, " padded"], [IBAN, "x".repeat(71)], [IBAN, "A"]]) {
    await assert.rejects(pool.query("INSERT INTO candidate_bank_details (principal_id, bank_id, iban, beneficiary_name) VALUES ($1, $2, $3, $4)",
      [id, bankId, iban, name]), { code: "23514" }, `${iban} / ${name}`);
  }
  const ref = principalAuditRef(id);
  const forged = randomUUID().replaceAll("-", "").padEnd(64, "0");
  const receipt = (fields: unknown, orgs: string[] = [], actor = ref, requestRef = randomUUID().replaceAll("-", "").padEnd(64, "0")) => pool.query(
    `INSERT INTO authorization_mutation_audit (request_ref, actor_principal_ref, operation, target_principal_ref, target_org_refs, before_summary, after_summary)
     VALUES ($1, $2, $3, $4, $5::text[], '{"valuePresent":false}'::jsonb, $6::jsonb)`,
    [requestRef, actor, BANK_DETAILS_OPERATION, ref, orgs, JSON.stringify({
      contractVersion: "3.0.0", personRef: "d".repeat(64), changeSetDigest: "e".repeat(64), fields,
      committedAt: FIXED.toISOString(), tokenRef: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    })]);
  await assert.rejects(receipt(["iban"]), { code: "23514" }, "a field other than bank_details");
  await assert.rejects(receipt([IBAN]), { code: "23514" }, "a value in the field list");
  await assert.rejects(receipt([BANK_DETAILS_FIELD], ["f".repeat(64)]), { code: "23514" }, "an organization reference");
  await assert.rejects(receipt([BANK_DETAILS_FIELD], [], "f".repeat(64)), { code: "23514" }, "someone else as the actor");
  // A well-formed row naming some other record is stored, but never served as this person's receipt.
  await receipt([BANK_DETAILS_FIELD], [], ref, forged);
  await assert.rejects(store.readReceipt(id, forged), /malformed bank details receipt/);
});

test("SHU182_BANK_PG_RETIRE_RACE a bank retired while the commit waits on its row is not stored", async () => {
  const id = await person();
  const bankId = await catalogueItem("bank");
  const details = { bankId, iban: IBAN, beneficiaryName: NAME };
  const retire = await pool.connect();
  try {
    await retire.query("BEGIN");
    await retire.query("UPDATE catalogue_items SET status = 'deleted', deleted_at = $2 WHERE id = $1", [bankId, FIXED]);
    // The retire holds the row; the commit must wait for it rather than read the old status.
    const pending = Promise.resolve(directCommit(id, null, details));
    for (let i = 0; i < 200; i++) {
      const waiting = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM catalogue_items WHERE catalogue_type%'");
      if (waiting.rows.length > 0) break;
      const done = await Promise.race([pending.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 10))]);
      if (done) break;
    }
    await retire.query("COMMIT");
    assert.deepEqual(await pending, { ok: false, reason: "state_changed" });
  } finally {
    retire.release();
  }
  assert.equal(await stored(id), undefined);
});

test("SHU182_BANK_PG_NAME_LENGTH a name the validator accepts fits the column, counted in code points", async () => {
  const id = await person();
  const bankId = await catalogueItem("bank");
  const longest = "\u{1F600}".repeat(70);
  const done = await rig(id).write({ bankId, iban: IBAN, beneficiaryName: longest });
  assert.ok(done.ok, JSON.stringify(done));
  assert.equal((await stored(id)).beneficiary_name, longest);
  const x = rig(id);
  for (const name of ["\u{1F600}".repeat(71), "\u{1F600}"]) {
    assert.deepEqual(await x.writer.preview({ principalRef: x.principalRef, change: x.change({ bankId, iban: IBAN, beneficiaryName: name }) }),
      { ok: false, reason: "invalid_value" }, name);
  }
});

test("SHU182_BANK_PG_PROJECTIONS stored bank details reach none of the platform's other reads", async () => {
  const id = await person();
  const bankId = await catalogueItem("bank");
  const sentinelName = "Sentinel Beneficiary Qzx";
  assert.ok((await rig(id).write({ bankId, iban: IBAN, beneficiaryName: sentinelName })).ok);
  const outputs = await Promise.all([
    authz.getPrincipal(id), authz.listPrincipals(), authz.listGrantsForPrincipal(id),
    authz.listAuthorizationMutationAuditRecords({ limit: 1_000 }), authz.listOrganizations(),
    new PostgresProfileRecordStore(pool).listAll(id),
    new PostgresPayContractStore(pool).listForCandidate(id),
    new PostgresSafeWriteStore({ pool }).forPrincipal(id).readField(personRecordRef(id), LANGUAGE_FIELD),
  ]);
  const wire = JSON.stringify(outputs);
  for (const secret of [IBAN, sentinelName, bankId]) assert.ok(!wire.includes(secret), `a non-finance read carries ${secret}`);
});

async function sources(dir: URL): Promise<URL[]> {
  const out: URL[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const next = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) out.push(...await sources(next));
    else if (/\.(ts|mts|js|mjs|sql)$/.test(entry.name)) out.push(next);
  }
  return out;
}

async function namers(pattern: RegExp): Promise<string[]> {
  // Compiled to dist/packages/db/test/, so the repository root is four levels up.
  const root = new URL("../../../../", import.meta.url);
  const found: string[] = [];
  for (const top of ["apps/", "packages/", "tools/"]) {
    for (const file of await sources(new URL(top, root))) {
      if (/\/test\//.test(file.pathname)) continue;
      if (pattern.test(await readFile(file, "utf8"))) found.push(file.pathname.slice(root.pathname.length));
    }
  }
  return found.sort();
}

test("SHU182_BANK_NOT_PROJECTED only the bank-details path can reach the table or decode its value", async () => {
  assert.deepEqual(await namers(/candidate_bank_details/), [
    "packages/db/migrations/0183_candidate_bank_details.sql",
    "packages/db/src/postgres-bank-details-store.ts",
  ]);
  // Whatever can read the store or decode its value is the bank-details path itself, or exports and wires it.
  assert.deepEqual(await namers(/\b(PostgresBankDetailsStore|parseBankDetailsValue|maskBankDetails|createBankDetails|BankDetailsStore)\b/), [
    "apps/gateway/src/bank-details.ts",
    "apps/gateway/src/login-runtime.ts",
    "packages/db/src/index.ts",
    "packages/db/src/postgres-bank-details-store.ts",
    "packages/pay-contracts/src/bank-write.ts",
  ]);
});
