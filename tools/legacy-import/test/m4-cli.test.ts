import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { M4_SOURCES, planM4, type M4Sources, type M4Table, type M4Writers } from "../src/m4-run.js";
import { acceptWrite, acquireSharedLock, contactSetDigest, digestKeyFingerprint, documentSetDigest, main, PROMOTE_BATCH, type CliDeps, type M4Receipt, type Provenance, type WriteTarget } from "../src/m4-cli.js";
import type { LegacyObjectReader } from "../src/m2-document-check.js";
import { ContactPromotionError, LinkReportError, type ContactPromotionResult, type LinkReport } from "@studenthub/db/import";

// Synthetic legacy rows only. SECRET marks every value that must never reach a receipt or a log.
const SECRET = "Secret";
const REVISION = "a".repeat(40);
const ACTOR = "c".repeat(64);
const TARGET = "11111111-1111-4111-8111-111111111111";
const OPERATOR = "operator-org";
const ARTIFACT = "e".repeat(64);
// Synthetic keys: the contact digest key and a different civil ID key, canonical base64.
const DIGEST_KEY = Buffer.alloc(32, 1).toString("base64");
const CIVIL_KEY = Buffer.alloc(32, 2).toString("base64");
// The contact values candidate 31 holds; none may reach a receipt, report or log.
const CONTACT_VALUES = ["+96550001234", "96550001234", "50001234", "secret.handle", "290010112345", "secret.person", "Secret.Person"];
const REFRESH = { ok: true, startedAt: "2026-11-23T01:00:00.000Z", finishedAt: "2026-11-23T01:05:00.000Z", totalRows: 42 };
const MIRROR_ID = "3e11fa47-71ca-11e1-9e33-c80aa9429562";

function sources(): M4Sources {
  const empty = Object.fromEntries(Object.keys(M4_SOURCES).map((t) => [t, []])) as unknown as Record<M4Table, Record<string, unknown>[]>;
  return {
    ...empty,
    mall: [{ mall_uuid: "m-1", mall_name_en: `${SECRET} Mall` }],
    brand: [{ brand_uuid: "b-1", company_id: 7, brand_name_en: `${SECRET} Brand` }],
    company: [{ company_id: 7, parent_company_id: null, company_name: `${SECRET} Co`, deleted: 0 }],
    store: [{ store_id: 1, company_id: 7, brand_uuid: "b-1", mall_uuid: "m-1", store_name: `${SECRET} Store`, deleted: 0 }],
    contact: [{ contact_uuid: "p-1", contact_name: `${SECRET} Person`, contact_email: "secret@example.com", deleted: 0 }],
    company_contact: [{ company_contact_uuid: "l-1", contact_uuid: "p-1", company_id: 7, allow_access: 0 },
      { company_contact_uuid: "l-2", contact_uuid: "p-1", company_id: 7, allow_access: 1 }],
    candidate: [{ candidate_id: 31, deleted: 0, candidate_name: `${SECRET} Person`, candidate_birth_date: "2010-11-23",
      candidate_phone: "+96550001234", profile_url: "secret.handle", candidate_civil_id: "290010112345", candidate_civil_need_verification: 0,
      candidate_email: "Secret.Person@example.invalid", candidate_email_verification: 1 },
      { candidate_id: 32, deleted: 1, candidate_name: `${SECRET} Gone` }],
  };
}

const ok = (n: number) => ({ inserted: n, unchanged: 0, conflicts: [], refused: [] });

/** A target database shared by every harness built on it: one marker, one writer lock. */
interface FakeDb {
  marker: { environment: string; targetId: string } | null;
  operators: Set<string>;
  /** Whether migration 0653 (the people snapshot table) is applied. */
  schemaReady: boolean;
  writer: object | null;
  /** Set when the lock-holding session is lost: the lock is gone and that session is dead. */
  sessionLost: boolean;
  /** The civil ID key the target's check value was provisioned under (base64), or null. */
  civilKeyCheck: string | null;
  /** Whether migration 0659 (the promotion schema) is applied. */
  promotionReady: boolean;
  /** Principals the promotion would list as pending, and what promoting each returns. */
  pending: string[];
  promoted: Map<string, ContactPromotionResult | Error>;
  /** contactSetDigest over the staged table, as the target would compute it. */
  staged: string;
  /** Whether the link report's tables are migrated. */
  linkReportReady: boolean;
  /** What the link report reads, or an error to throw. */
  links: LinkReport | Error;
}
const fakeDb = (): FakeDb => ({ marker: { environment: "staging", targetId: TARGET }, operators: new Set([OPERATOR]), schemaReady: true, writer: null, sessionLost: false, civilKeyCheck: CIVIL_KEY,
  promotionReady: true, pending: [], promoted: new Map(), staged: "0".repeat(64), linkReportReady: true,
  links: { imported: 0, linked: 0, ids: { "link.unlinked": [], "link.notImported": [], "link.multiplePrincipals": [], "link.contactTaken": [], "link.emailMismatch": [] } } });

interface HarnessOptions {
  env?: Record<string, string | undefined>;
  db?: FakeDb;
  lockHeld?: boolean;
  writers?: Partial<M4Writers>;
  rows?: M4Sources;
  dir?: string;
  provenance?: Partial<Provenance>;
  /** The run's clock, default 2026-11-23T02:00:00.000Z. */
  now?: string;
  /** The legacy bucket for doccheck; default: every object missing. */
  bucket?: LegacyObjectReader | (() => LegacyObjectReader);
  /** Added to the candidate count after the rows are read (a copy changing underneath). */
  countDrift?: number;
  /** The mirror's `@@server_uuid`; default MIRROR_ID. */
  mirrorId?: string;
}

interface Harness {
  readonly dir: string;
  readonly invocation: string;
  readonly deps: CliDeps;
  readonly calls: string[];
  readonly out: string[];
  readonly err: string[];
  readonly state: { locked: boolean; released: number; closed: number; reads: number; receiptAtRelease: string | undefined };
  readonly file: (name: string) => string;
  readonly receipt: (mode: "plan" | "write" | "keycheck" | "promote" | "linkreport" | "doccheck") => M4Receipt;
}

function harness(opts: HarnessOptions = {}): Harness {
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), "m4-cli-"));
  const file = (name: string) => path.join(dir, name);
  if (!existsSync(file("refresh.json"))) writeFileSync(file("refresh.json"), JSON.stringify(REFRESH));
  const invocation = opts.env && "M4_INVOCATION" in opts.env ? opts.env.M4_INVOCATION ?? "" : randomUUID();
  const calls: string[] = [], out: string[] = [], err: string[] = [];
  const state = { locked: false, released: 0, closed: 0, reads: 0, receiptAtRelease: undefined as string | undefined };
  const rows = opts.rows ?? sources();
  const db = opts.db ?? fakeDb();
  const me = {};
  const writers: M4Writers = {
    catalogue: async (table, items) => { calls.push(`catalogue.${table}`); return { ...ok(items.length), merged: 0, adopted: 0 }; },
    companies: async (r) => { calls.push("company"); return ok(r.length); },
    brandLinks: async (r) => { calls.push("brand_company"); return ok(r.length); },
    stores: async (r) => { calls.push("store"); return ok(r.length); },
    contacts: async (r) => { calls.push("company_contact"); return ok(r.length); },
    people: async (r) => { calls.push("candidate"); return ok(r.length); },
    personContacts: async (r) => { calls.push("candidate_contact"); return ok(r.length); },
    ...opts.writers,
  };
  const target: WriteTarget = {
    marker: async () => db.marker,
    hasOperator: async (id) => db.operators.has(id),
    schemaReady: async () => db.schemaReady,
    civilKey: async (key) => (db.civilKeyCheck === null ? "missing" : key.toString("base64") === db.civilKeyCheck ? "ok" : "mismatch"),
    provisionCivilKeyCheck: async (key, targetId) => {
      calls.push("keycheck");
      if (db.marker?.targetId !== targetId) return "mismatch";
      if (db.civilKeyCheck === null) { db.civilKeyCheck = key.toString("base64"); return "set"; }
      return key.toString("base64") === db.civilKeyCheck ? "ok" : "mismatch";
    },
    claimWriter: async () => { if (db.writer && db.writer !== me) return false; db.writer = me; return true; },
    writers: () => {
      assert.equal(db.writer, me, "writers are used only by the lock holder");
      // Like the session-bound pool: every batch first checks the session still holds the lock.
      const fenced = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
        if (db.sessionLost || db.writer !== me) throw new Error("m4.writerLost");
        return f(...a);
      };
      return { catalogue: fenced(writers.catalogue), companies: fenced(writers.companies), brandLinks: fenced(writers.brandLinks), stores: fenced(writers.stores), contacts: fenced(writers.contacts), people: fenced(writers.people), personContacts: fenced(writers.personContacts) };
    },
    promotionReady: async () => db.promotionReady,
    promoter: () => {
      assert.equal(db.writer, me, "the promoter is used only by the lock holder");
      return {
        pending: async (limit, after) => {
          calls.push(`pending:${after ?? "-"}`);
          return [...db.pending].sort().filter((id) => after === undefined || id > after).slice(0, limit);
        },
        promote: async (id) => {
          calls.push("promote");
          if (db.sessionLost || db.writer !== me) throw new Error("m4.writerLost");
          const result = db.promoted.get(id) ?? { kind: "skipped", reason: "notStaged" };
          if (result instanceof Error) throw result;
          // Like the database: a promoted principal is no longer pending.
          if (result.kind === "promoted") db.pending = db.pending.filter((p) => p !== id);
          return result;
        },
      };
    },
    stagedContacts: async () => { assert.equal(db.writer, me, "the staged set is read under the writer lock"); return db.staged; },
    linkReportReady: async () => db.linkReportReady,
    linkReport: async () => {
      calls.push("linkReport");
      assert.equal(db.writer, null, "the link report takes no writer lock");
      if (db.links instanceof Error) throw db.links;
      return db.links;
    },
    stillHeld: async () => db.writer === me && !db.sessionLost,
    lost: () => db.writer === me && db.sessionLost,
    close: async () => {
      state.closed++;
      // What the receipt said at the moment this invocation gave up the writer lock.
      if (db.writer === me) {
        const file = path.join(deps.env.M4_OUTPUT_DIR!, `${invocation}.write.receipt.json`);
        state.receiptAtRelease = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).status : "none";
        db.writer = null;
      }
    },
  };
  const deps: CliDeps = {
    env: {
      M4_INVOCATION: invocation, M4_OUTPUT_DIR: file("out"),
      M4_REVISION: REVISION, M4_ARTIFACT_DIGEST: ARTIFACT, M4_TARGET_ID: TARGET, M4_OPERATOR_ORG_ID: OPERATOR,
      LEGACY_REFRESH_REPORT: file("refresh.json"), LEGACY_REFRESH_LOCK: file("lock"),
      M4_IMPORT_ACTOR: ACTOR, M4_DATABASE_URL: "postgres://unused/x",
      M4_CONTACT_DIGEST_KEY: DIGEST_KEY, M4_CIVIL_ID_ENCRYPTION_KEY: CIVIL_KEY,
      ...opts.env,
    },
    lock: async () => {
      if (opts.lockHeld === false) return { held: false };
      state.locked = true;
      return { held: true, release: () => { state.locked = false; state.released++; } };
    },
    reader: () => ({
      rows: async (sql) => {
        // Every read happens with the refresh lock held.
        assert.equal(state.locked, true);
        state.reads++;
        if (sql.includes("@@server_uuid")) return [{ id: opts.mirrorId ?? MIRROR_ID }];
        const table = /FROM `([a-z_]+)`$/.exec(sql)![1] as M4Table;
        if (sql.includes("COUNT(*)")) return [{ n: rows[table].length + (state.reads > 1 ? opts.countDrift ?? 0 : 0) }];
        return rows[table];
      },
    }),
    target: () => target,
    bucket: () => {
      const b = opts.bucket;
      if (typeof b === "function") return b();
      return b ?? { read: async () => { assert.equal(state.locked, true); return { kind: "missing" }; } };
    },
    provenance: () => ({ head: REVISION, clean: true, artifact: ARTIFACT, ...opts.provenance }),
    now: () => new Date(opts.now ?? "2026-11-23T02:00:00.000Z"),
    log: (line) => out.push(line),
    error: (line) => {
      err.push(line);
    },
  };
  const receipt = (mode: "plan" | "write" | "keycheck" | "promote" | "linkreport" | "doccheck") => JSON.parse(readFileSync(path.join(file("out"), `${invocation}.${mode}.receipt.json`), "utf8")) as M4Receipt;
  return { dir, invocation, deps, calls, out, err, state, file, receipt };
}

const cleanup = (...hs: Harness[]) => { for (const h of hs) rmSync(h.dir, { recursive: true, force: true }); };

async function planId(opts: HarnessOptions = {}): Promise<string> {
  const h = harness(opts);
  try {
    assert.equal(await main(["plan"], h.deps), 0);
    return h.receipt("plan").plan!;
  } finally { if (!opts.dir) cleanup(h); }
}

test("plan publishes its own counts-only receipt bound to the invocation, revision, artifact, refresh and destination", async () => {
  const h = harness();
  try {
    assert.equal(await main(["plan"], h.deps), 0);
    const r = h.receipt("plan");
    assert.deepEqual([r.schemaVersion, r.kind, r.status, r.invocation, r.revision, r.artifact, r.target, r.operator],
      [2, "plan", "ok", h.invocation, REVISION, ARTIFACT, TARGET, OPERATOR]);
    assert.deepEqual(r.refresh, { startedAt: REFRESH.startedAt, finishedAt: REFRESH.finishedAt, totalRows: 42 });
    assert.match(r.plan!, /^[0-9a-f]{64}$/);
    assert.equal(r.steps.length, 14);
    assert.equal(r.today, "2026-11-23");
    // M-1 on the run date: exactly 16 that day, and an archived candidate reported by rule only.
    assert.deepEqual(r.steps.at(-2), { step: "candidate", legacy: 2, mapped: 1, rules: { "candidate.archived": 1 } });
    // Its contact values are staged for the imported candidate only; the archived one is not read.
    assert.deepEqual(r.steps.at(-1), { step: "candidate_contact", legacy: 2, mapped: 1, rules: {} });
    assert.deepEqual(r.steps.find((s) => s.step === "company_contact")!.rules, { "contact.access": 1 });
    assert.deepEqual(h.calls, []);
    const out = h.file("out");
    assert.deepEqual(readdirSync(out).sort(), [`${h.invocation}.claim`, `${h.invocation}.plan.receipt.json`, `${h.invocation}.plan.report.json`]);
    for (const f of readdirSync(out)) assert.equal(statSync(path.join(out, f)).mode & 0o777, 0o600, f);
    // The receipt and the log carry no legacy id or value; the private report keeps ids by rule.
    // The invocation is a random UUID, which can itself contain a fixture id such as "b-1"; it is
    // checked exactly above, so it is removed before searching for leaked ids.
    const shared = (readFileSync(path.join(out, `${h.invocation}.plan.receipt.json`), "utf8") + h.out.join("\n")).replaceAll(h.invocation, "<invocation>");
    for (const id of ["l-1", "l-2", "p-1", "b-1", "m-1", SECRET, "example.com", DIGEST_KEY, CIVIL_KEY, ...CONTACT_VALUES]) assert.ok(!shared.includes(id), id);
    const report = readFileSync(path.join(out, `${h.invocation}.plan.report.json`), "utf8");
    assert.ok(report.includes("l-2") && !report.includes(SECRET));
    for (const value of [DIGEST_KEY, CIVIL_KEY, "example.invalid", ...CONTACT_VALUES]) assert.ok(!report.includes(value), value);
    assert.ok(h.out.includes(`m4 plan ok invocation=${h.invocation} plan=${r.plan}`));
    assert.equal(h.state.released, 1);
  } finally { cleanup(h); }
});

test("the plan identity follows the revision, the artifact, the refresh, the destination and every row's digest", async () => {
  const base = await planId();
  assert.equal(await planId(), base);
  const variants: HarnessOptions[] = [
    { env: { M4_REVISION: "b".repeat(40) }, provenance: { head: "b".repeat(40) } },
    { env: { M4_ARTIFACT_DIGEST: "f".repeat(64) }, provenance: { artifact: "f".repeat(64) } },
    { env: { M4_TARGET_ID: "22222222-2222-4222-8222-222222222222" } },
    { env: { M4_OPERATOR_ORG_ID: "another-operator" } },
    { rows: { ...sources(), company: [{ company_id: 7, parent_company_id: null, company_name: `${SECRET} Co renamed`, deleted: 0 }] } },
    // A staged contact value, and the key its HMAC is taken under.
    { rows: { ...sources(), candidate: sources().candidate.map((c) => (c.candidate_id === 31 ? { ...c, candidate_phone: "+96550001235" } : c)) } },
    { rows: { ...sources(), candidate: sources().candidate.map((c) => (c.candidate_id === 31 ? { ...c, candidate_email_verification: 0 } : c)) } },
    { env: { M4_CONTACT_DIGEST_KEY: Buffer.alloc(32, 3).toString("base64") } },
  ];
  for (const v of variants) assert.notEqual(await planId(v), base, JSON.stringify(v.env ?? "rows"));
  const h = harness();
  try {
    writeFileSync(h.file("refresh.json"), JSON.stringify({ ...REFRESH, totalRows: 43 }));
    assert.equal(await main(["plan"], h.deps), 0);
    assert.notEqual(h.receipt("plan").plan, base);
  } finally { cleanup(h); }
});

test("the plan binds the Kuwait run date: a write on the next Kuwait day is refused before any write", async () => {
  // 20:59Z is 23:59 on 23 Nov in Kuwait; 21:01Z is already 24 Nov there.
  const expected = await planId({ now: "2026-11-23T20:59:00.000Z" });
  assert.equal(await planId({ now: "2026-11-23T00:00:00.000Z" }), expected, "same Kuwait day, same plan");
  const late = harness({ env: { M4_EXPECTED_PLAN: expected }, now: "2026-11-23T21:01:00.000Z" });
  try {
    assert.equal(await main(["write"], late.deps), 2);
    assert.deepEqual(late.err, ["m4: refused.planMismatch"]);
    assert.deepEqual(late.calls, []);
    assert.equal(late.receipt("write").today, "2026-11-24");
  } finally { cleanup(late); }
  const same = harness({ env: { M4_EXPECTED_PLAN: expected }, now: "2026-11-23T20:59:30.000Z" });
  try { assert.equal(await main(["write"], same.deps), 0); } finally { cleanup(same); }
});

test("the plan binds the reconciliation: same mapped rows and digests with other issue evidence is refused before any write", async () => {
  const expected = await planId();
  const base = sources();
  const gone = base.candidate[1]!;
  const variants: [string, M4Sources][] = [
    // One more row the mapper sets aside: source count and issues change, mapped rows do not.
    ["extra excluded row", { ...base, candidate: [...base.candidate, { candidate_id: 33, deleted: 1, candidate_name: `${SECRET} Gone too` }] }],
    // Same source count, same mapped rows: the excluded row now fails another rule.
    ["other rule, same count", { ...base, candidate: [base.candidate[0]!, { ...gone, candidate_id: "not-an-id" }] }],
    // Same count, same rule: the excluded row is another legacy id.
    ["other excluded id", { ...base, candidate: [base.candidate[0]!, { ...gone, candidate_id: 34 }] }],
    // A lookup row the mapped candidates never reference.
    ["unreferenced lookup row", { ...base, country: [{ country_id: 9, country_nationality_name_en: `${SECRET}ian` }] }],
  ];
  const mapped = (rows: M4Sources) => { const p = planM4(rows, "2026-11-23"); return [p.people.people, p.personContacts.contacts, p.catalogue.map((c) => c.items), p.companies.organizations, p.brandLinks.links, p.stores.stores, p.contacts.contacts]; };
  for (const [label, rows] of variants) {
    assert.deepEqual(mapped(rows), mapped(base), `${label}: every mapped row and digest is the same`);
    const h = harness({ env: { M4_EXPECTED_PLAN: expected }, rows });
    try {
      assert.equal(await main(["write"], h.deps), 2, label);
      assert.deepEqual(h.err, ["m4: refused.planMismatch"], label);
      assert.deepEqual(h.calls, [], label);
      const r = h.receipt("write");
      assert.deepEqual([r.status, r.code], ["refused", "planMismatch"], label);
      assert.ok(!JSON.stringify(r).includes(SECRET), label);
    } finally { cleanup(h); }
  }
  // The same candidate row mapped the same way in both: the people step itself is unchanged.
  const h = harness({ env: { M4_EXPECTED_PLAN: expected } });
  try { assert.equal(await main(["write"], h.deps), 0); } finally { cleanup(h); }
});

test("write imports in order under the writer lock and its own receipt passes acceptWrite with exit 0", async () => {
  const expected = await planId();
  const db = fakeDb();
  const h = harness({ env: { M4_EXPECTED_PLAN: expected }, db });
  try {
    const code = await main(["write"], h.deps);
    assert.equal(code, 0);
    assert.equal(h.calls.length, 14);
    assert.equal(h.calls.at(-1), "candidate_contact");
    const r = h.receipt("write");
    assert.deepEqual([r.kind, r.status, r.plan, r.invocation, r.code, r.unconfirmed], ["write", "ok", expected, h.invocation, undefined, undefined]);
    assert.deepEqual(r.steps.map((s) => s.step), h.calls);
    assert.ok(acceptWrite(r, h.invocation, expected, code));
    assert.ok(!acceptWrite(r, h.invocation, expected, 1));
    assert.ok(!acceptWrite(r, randomUUID(), expected, 0));
    assert.ok(!acceptWrite(r, h.invocation, "d".repeat(64), 0));
    assert.ok(!acceptWrite({ ...r, status: "started" }, h.invocation, expected, 0));
    assert.ok(!acceptWrite(undefined, h.invocation, expected, 0));
    assert.equal(db.writer, null, "the writer lock is released");
    assert.equal(h.state.receiptAtRelease, "ok", "the lock is held until the terminal receipt is published");
    assert.deepEqual([h.state.released, h.state.closed], [1, 1]);
  } finally { cleanup(h); }
});

test("the writer lock is held from before the first write until the terminal receipt is published", async () => {
  const expected = await planId();
  const db = fakeDb();
  const seen: { status: string; held: boolean }[] = [];
  let h: Harness;
  const watch = (step: string) => async (...args: unknown[]) => {
    seen.push({ status: JSON.parse(readFileSync(path.join(h.file("out"), `${h.invocation}.write.receipt.json`), "utf8")).status, held: db.writer !== null });
    h.calls.push(step);
    return step === "catalogue" ? { ...ok(0), merged: 0, adopted: 0 } : ok((args[0] as unknown[]).length);
  };
  h = harness({ env: { M4_EXPECTED_PLAN: expected }, db, writers: { catalogue: watch("catalogue") as M4Writers["catalogue"], contacts: watch("company_contact") as M4Writers["contacts"] } });
  try {
    assert.equal(await main(["write"], h.deps), 0);
    assert.deepEqual(seen[0], { status: "started", held: true });
    assert.ok(seen.every((s) => s.held && s.status === "started"));
    assert.equal(h.receipt("write").status, "ok");
  } finally { cleanup(h); }
});

test("a second writer on the same target is refused while the first holds it, and publishes its own refusal", async () => {
  const expected = await planId();
  const db = fakeDb();
  let second: Harness | undefined;
  let secondCode: number | undefined;
  const first = harness({ env: { M4_EXPECTED_PLAN: expected }, db, writers: {
    stores: async (rows) => {
      // Mid-run, a second invocation for the same plan and target tries to write.
      second = harness({ env: { M4_EXPECTED_PLAN: expected }, db });
      secondCode = await main(["write"], second.deps);
      return ok(rows.length);
    },
  } });
  try {
    assert.equal(await main(["write"], first.deps), 0);
    assert.equal(secondCode, 2);
    assert.deepEqual(second!.err, ["m4: refused.writerBusy"]);
    assert.deepEqual(second!.calls, []);
    const r = second!.receipt("write");
    assert.deepEqual([r.status, r.code, r.invocation, r.plan], ["refused", "writerBusy", second!.invocation, expected]);
    assert.ok(!acceptWrite(r, second!.invocation, expected, secondCode!));
    assert.equal(first.receipt("write").status, "ok");
  } finally { cleanup(first, ...(second ? [second] : [])); }
});

test("after a prior success, a same-plan retry is its own attempt: a refusal or a re-run never borrows the earlier pass", async () => {
  const expected = await planId();
  const db = fakeDb();
  const dir = mkdtempSync(path.join(tmpdir(), "m4-cli-"));
  const shared = { env: { M4_EXPECTED_PLAN: expected }, db, dir };
  const first = harness(shared);
  try {
    assert.equal(await main(["write"], first.deps), 0);
    assert.ok(acceptWrite(first.receipt("write"), first.invocation, expected, 0));

    // A retry refused early (here the refresh holds its lock) publishes a refusal under its own name.
    const locked = harness({ ...shared, lockHeld: false });
    const lockedCode = await main(["write"], locked.deps);
    assert.equal(lockedCode, 2);
    assert.deepEqual([locked.receipt("write").status, locked.receipt("write").code], ["refused", "locked"]);
    assert.ok(!acceptWrite(locked.receipt("write"), locked.invocation, expected, lockedCode));

    // A retry whose target lost its marker is refused the same way.
    db.marker = null;
    const unmarked = harness(shared);
    assert.equal(await main(["write"], unmarked.deps), 2);
    assert.deepEqual([unmarked.receipt("write").status, unmarked.receipt("write").code], ["refused", "target"]);
    db.marker = { environment: "staging", targetId: TARGET };

    // Re-using the first run's name is refused outright and touches none of its files.
    const before = readFileSync(path.join(dir, "out", `${first.invocation}.write.receipt.json`), "utf8");
    const reused = harness({ ...shared, env: { ...shared.env, M4_INVOCATION: first.invocation } });
    assert.equal(await main(["write"], reused.deps), 2);
    assert.deepEqual(reused.err, ["m4: refused.invocationUsed"]);
    assert.equal(readFileSync(path.join(dir, "out", `${first.invocation}.write.receipt.json`), "utf8"), before);
    assert.deepEqual(reused.calls, []);

    // A fresh same-plan re-run is a new attempt with its own receipt; the rows are already in.
    const again = harness(shared);
    assert.equal(await main(["write"], again.deps), 0);
    assert.notEqual(again.invocation, first.invocation);
    assert.equal(again.receipt("write").invocation, again.invocation);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a write step with refused rows or conflicts ends refused_rows, exit 3, with counts only", async () => {
  const expected = await planId();
  const h = harness({ env: { M4_EXPECTED_PLAN: expected }, writers: {
    stores: async (rows) => ({ inserted: 0, unchanged: 0, conflicts: rows.map((r) => ({ legacyId: r.legacyId, existingDigest: "a".repeat(64), incomingDigest: "b".repeat(64) })), refused: [] }),
    contacts: async (rows) => ({ inserted: 0, unchanged: 0, conflicts: [], refused: rows.map((r) => ({ legacyId: r.legacyId, code: "no_organization" as const })) }),
  } });
  try {
    const code = await main(["write"], h.deps);
    assert.equal(code, 3);
    const r = h.receipt("write");
    assert.equal(r.status, "refused_rows");
    assert.deepEqual(r.steps.find((s) => s.step === "company_contact")!.write!.refused, { no_organization: 1 });
    assert.equal(r.steps.find((s) => s.step === "store")!.write!.conflicts, 1);
    assert.ok(!acceptWrite(r, h.invocation, expected, code));
    assert.ok(!readFileSync(path.join(h.file("out"), `${h.invocation}.write.receipt.json`), "utf8").includes("l-1"));
  } finally { cleanup(h); }
});

test("a late failure ends failed, listing the confirmed steps and the unconfirmed ones from the step that failed", async () => {
  const expected = await planId();
  const h = harness({ env: { M4_EXPECTED_PLAN: expected }, writers: {
    stores: async () => { throw new Error(`duplicate key value (${SECRET} Store)`); },
  } });
  try {
    assert.equal(await main(["write"], h.deps), 1);
    const r = h.receipt("write");
    assert.deepEqual([r.status, r.code, r.plan], ["failed", "m4.failed", expected]);
    assert.deepEqual(r.steps.map((s) => s.step), h.calls); // the failing stores writer records no call
    assert.deepEqual(r.unconfirmed, ["store", "company_contact", "candidate", "candidate_contact"]);
    assert.deepEqual(h.err, ["m4: m4.failed"]);
    assert.ok(!acceptWrite(r, h.invocation, expected, 1));
    const shared = readFileSync(path.join(h.file("out"), `${h.invocation}.write.receipt.json`), "utf8") + h.err.join("\n") + h.out.join("\n");
    assert.ok(!shared.includes(SECRET));
    assert.deepEqual([h.state.released, h.state.closed], [1, 1]);
  } finally { cleanup(h); }
});

test("a step whose writer committed but whose result fails the checks is not counted as confirmed", async () => {
  const expected = await planId();
  const h = harness({ env: { M4_EXPECTED_PLAN: expected }, writers: {
    brandLinks: async (rows) => { h.calls.push("brand_company"); return { inserted: 0, unchanged: 0, conflicts: [], refused: rows.map(() => ({ legacyId: `${SECRET} id`, code: "invalid" })) }; },
  } as Partial<M4Writers> });
  try {
    assert.equal(await main(["write"], h.deps), 1);
    const r = h.receipt("write");
    assert.equal(r.status, "failed");
    assert.equal(r.code, "m4.report.unsafeRefusal");
    assert.equal(r.steps.at(-1)!.step, "company");
    assert.deepEqual(r.unconfirmed, ["brand_company", "store", "company_contact", "candidate", "candidate_contact"]);
    assert.ok(!JSON.stringify(r).includes(SECRET));
  } finally { cleanup(h); }
});

test("every refusal exits 2 before any write; after the name is claimed it publishes its own refused receipt", async () => {
  const expected = await planId();
  const cases: { name: string; argv: string[]; opts: HarnessOptions; refresh?: unknown; receipt: boolean; reads: boolean }[] = [
    { name: "usage", argv: [], opts: {}, receipt: false, reads: false },
    { name: "usage", argv: ["import"], opts: {}, receipt: false, reads: false },
    { name: "invocation", argv: ["plan"], opts: { env: { M4_INVOCATION: undefined } }, receipt: false, reads: false },
    { name: "invocation", argv: ["write"], opts: { env: { M4_INVOCATION: "../x", M4_EXPECTED_PLAN: expected } }, receipt: false, reads: false },
    { name: "revision", argv: ["plan"], opts: { env: { M4_REVISION: "main" } }, receipt: true, reads: false },
    { name: "destination", argv: ["plan"], opts: { env: { M4_TARGET_ID: undefined } }, receipt: true, reads: false },
    { name: "destination", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected, M4_OPERATOR_ORG_ID: "" } }, receipt: true, reads: false },
    { name: "writeConfig", argv: ["write"], opts: {}, receipt: true, reads: false },
    { name: "writeConfig", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected, M4_IMPORT_ACTOR: "x" } }, receipt: true, reads: false },
    { name: "writeConfig", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected, M4_DATABASE_URL: undefined } }, receipt: true, reads: false },
    { name: "locked", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected }, lockHeld: false }, receipt: true, reads: false },
    { name: "locked", argv: ["plan"], opts: { lockHeld: false }, receipt: true, reads: false },
    { name: "refreshNotOk", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected } }, refresh: { ...REFRESH, ok: false }, receipt: true, reads: false },
    { name: "refreshNotOk", argv: ["plan"], opts: {}, refresh: "not json", receipt: true, reads: false },
    { name: "planMismatch", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: "d".repeat(64) } }, receipt: true, reads: true },
    { name: "planMismatch", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected, M4_REVISION: "b".repeat(40) }, provenance: { head: "b".repeat(40) } }, receipt: true, reads: true },
    { name: "planMismatch", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected, M4_ARTIFACT_DIGEST: "f".repeat(64) }, provenance: { artifact: "f".repeat(64) } }, receipt: true, reads: true },
    { name: "provenance", argv: ["plan"], opts: { env: { M4_ARTIFACT_DIGEST: undefined } }, receipt: true, reads: false },
    { name: "provenance", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected, M4_ARTIFACT_DIGEST: "nope" } }, receipt: true, reads: false },
    { name: "provenance", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected }, provenance: { artifact: "f".repeat(64) } }, receipt: true, reads: false },
    { name: "provenance", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected }, provenance: { artifact: null } }, receipt: true, reads: false },
    { name: "provenance", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected }, provenance: { head: "b".repeat(40) } }, receipt: true, reads: false },
    { name: "provenance", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected }, provenance: { head: null } }, receipt: true, reads: false },
    { name: "provenance", argv: ["plan"], opts: { provenance: { clean: false } }, receipt: true, reads: false },
    { name: "target", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected }, db: { ...fakeDb(), marker: null } }, receipt: true, reads: true },
    { name: "target", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected }, db: { ...fakeDb(), marker: { environment: "production", targetId: TARGET } } }, receipt: true, reads: true },
    { name: "target", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected }, db: { ...fakeDb(), marker: { environment: "staging", targetId: "33333333-3333-4333-8333-333333333333" } } }, receipt: true, reads: true },
    { name: "operator", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected }, db: { ...fakeDb(), operators: new Set(["someone-else"]) } }, receipt: true, reads: true },
    { name: "schema", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected }, db: { ...fakeDb(), schemaReady: false } }, receipt: true, reads: true },
    { name: "writerBusy", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected }, db: { ...fakeDb(), writer: {} } }, receipt: true, reads: true },
  ];
  for (const c of cases) {
    const h = harness(c.opts);
    const label = `${c.name} ${c.argv.join(" ")}`;
    try {
      if (c.refresh !== undefined) writeFileSync(h.file("refresh.json"), typeof c.refresh === "string" ? c.refresh : JSON.stringify(c.refresh));
      assert.equal(await main(c.argv, h.deps), 2, label);
      assert.deepEqual(h.err, [`m4: refused.${c.name}`], label);
      assert.deepEqual(h.calls, [], label);
      const out = h.file("out");
      const files = existsSync(out) ? readdirSync(out).sort() : [];
      const mode = c.argv[0];
      assert.deepEqual(files, c.receipt ? [`${h.invocation}.claim`, `${h.invocation}.${mode}.receipt.json`] : [], label);
      if (c.receipt) {
        const r = h.receipt(mode as "plan" | "write");
        assert.deepEqual([r.status, r.code, r.invocation, r.steps], ["refused", c.name, h.invocation, []], label);
      }
      assert.equal(h.state.reads > 0, c.reads, label);
      assert.equal(h.state.locked, false, label);
    } finally { cleanup(h); }
  }
});

test("losing the lock session mid-write stops further writes, fails the attempt and keeps confirmed and unconfirmed apart", async () => {
  const expected = await planId();
  const db = fakeDb();
  const h = harness({ env: { M4_EXPECTED_PLAN: expected }, db, writers: {
    brandLinks: async (rows) => { h.calls.push("brand_company"); db.sessionLost = true; throw new Error("Connection terminated unexpectedly"); },
  } });
  try {
    const code = await main(["write"], h.deps);
    assert.equal(code, 1);
    const r = h.receipt("write");
    assert.deepEqual([r.status, r.code], ["failed", "m4.writerLost"]);
    assert.equal(r.steps.at(-1)!.step, "company");
    assert.deepEqual(r.unconfirmed, ["brand_company", "store", "company_contact", "candidate", "candidate_contact"]);
    assert.ok(!h.calls.includes("store") && !h.calls.includes("company_contact"));
    assert.ok(!acceptWrite(r, h.invocation, expected, code));
  } finally { cleanup(h); }
});

test("a lock lost after the last batch still fails the attempt: exclusivity is re-checked before the outcome is published", async () => {
  const expected = await planId();
  const db = fakeDb();
  const h = harness({ env: { M4_EXPECTED_PLAN: expected }, db, writers: {
    personContacts: async (rows) => { h.calls.push("candidate_contact"); db.sessionLost = true; return ok(rows.length); },
  } });
  try {
    const code = await main(["write"], h.deps);
    assert.equal(code, 1);
    const r = h.receipt("write");
    assert.deepEqual([r.status, r.code, r.steps.length, r.unconfirmed], ["failed", "m4.writerLost", 14, []]);
    assert.ok(!acceptWrite(r, h.invocation, expected, code));
  } finally { cleanup(h); }
});

test("the shared lock is refused while another process holds the refresh lock exclusively", async (t) => {
  const { spawn, spawnSync } = await import("node:child_process");
  if (spawnSync("flock", ["--version"]).status !== 0) { t.skip("flock not installed"); return; }
  const dir = mkdtempSync(path.join(tmpdir(), "m4-lock-"));
  const lockPath = path.join(dir, "lock");
  writeFileSync(lockPath, "");
  try {
    assert.equal((await acquireSharedLock(path.join(dir, "absent"))).held, false);
    const free = await acquireSharedLock(lockPath);
    assert.equal(free.held, true);
    // Two readers may share it.
    const second = await acquireSharedLock(lockPath);
    assert.equal(second.held, true);
    if (second.held) second.release();
    // While we hold it shared, the refresh cannot take it exclusively.
    assert.notEqual(spawnSync("flock", ["--exclusive", "--nonblock", lockPath, "true"]).status, 0);
    if (free.held) free.release();
    assert.equal(spawnSync("flock", ["--exclusive", "--nonblock", lockPath, "true"]).status, 0);
    // While the refresh holds it exclusively, we are refused.
    const holder = spawn("flock", ["--exclusive", lockPath, "sleep", "5"], { stdio: "ignore" });
    try {
      for (let i = 0; i < 50 && spawnSync("flock", ["--shared", "--nonblock", lockPath, "true"]).status === 0; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal((await acquireSharedLock(lockPath)).held, false);
    } finally { holder.kill(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the contact keys come from the environment only: a missing, malformed or shared key is refused before any read", async () => {
  const cases: [string, "plan" | "write", Record<string, string | undefined>][] = [
    ["no digest key", "plan", { M4_CONTACT_DIGEST_KEY: undefined }],
    ["short digest key", "plan", { M4_CONTACT_DIGEST_KEY: Buffer.alloc(31, 1).toString("base64") }],
    ["non-canonical base64", "plan", { M4_CONTACT_DIGEST_KEY: `${DIGEST_KEY}\n` }],
    ["no civil ID key for a write", "write", { M4_CIVIL_ID_ENCRYPTION_KEY: undefined, M4_EXPECTED_PLAN: "d".repeat(64) }],
    ["the same key twice", "write", { M4_CIVIL_ID_ENCRYPTION_KEY: DIGEST_KEY, M4_EXPECTED_PLAN: "d".repeat(64) }],
  ];
  for (const [label, mode, env] of cases) {
    const h = harness({ env });
    try {
      assert.equal(await main([mode], h.deps), 2, label);
      assert.deepEqual(h.err, ["m4: refused.contactKeys"], label);
      assert.deepEqual([h.calls, h.state.reads, h.state.locked], [[], 0, false], label);
      const r = h.receipt(mode);
      assert.deepEqual([r.status, r.code], ["refused", "contactKeys"], label);
      assert.ok(![DIGEST_KEY, CIVIL_KEY].some((k) => JSON.stringify(r).includes(k)), label);
    } finally { cleanup(h); }
  }
  // A plan needs only the digest key: the civil ID key is a write setting.
  const h = harness({ env: { M4_CIVIL_ID_ENCRYPTION_KEY: undefined } });
  try { assert.equal(await main(["plan"], h.deps), 0); } finally { cleanup(h); }
});

test("a write refuses before any step unless the civil ID key opens the target's provisioned check", async () => {
  const expected = await planId();
  const wrongKey = Buffer.alloc(32, 9).toString("base64");
  for (const [label, db, env] of [
    ["no check provisioned", { ...fakeDb(), civilKeyCheck: null }, {}],
    ["a well-formed wrong key", fakeDb(), { M4_CIVIL_ID_ENCRYPTION_KEY: wrongKey }],
  ] as [string, FakeDb, Record<string, string>][]) {
    const h = harness({ env: { M4_EXPECTED_PLAN: expected, ...env }, db });
    try {
      assert.equal(await main(["write"], h.deps), 2, label);
      assert.deepEqual(h.err, ["m4: refused.civilKey"], label);
      assert.deepEqual(h.calls, [], label);
      assert.equal(db.writer, null, label);
      const r = h.receipt("write");
      assert.deepEqual([r.status, r.code, r.steps], ["refused", "civilKey", []], label);
      assert.ok(![wrongKey, CIVIL_KEY, DIGEST_KEY].some((k) => JSON.stringify(r).includes(k)), label);
    } finally { cleanup(h); }
  }
});

test("keycheck provisions the target's check once, confirms the same key, and refuses another; it reads no legacy data", async () => {
  const db = { ...fakeDb(), civilKeyCheck: null };
  const run = async (env: Record<string, string | undefined>) => {
    const h = harness({ env, db });
    try {
      const code = await main(["keycheck"], h.deps);
      const r = h.receipt("keycheck" as "plan");
      assert.equal(h.state.reads, 0);
      assert.ok(![CIVIL_KEY, DIGEST_KEY, Buffer.alloc(32, 9).toString("base64")].some((k) => JSON.stringify(r).includes(k) || h.out.join().includes(k)));
      return { code, status: r.status, rcode: r.code, out: h.out, err: h.err, receipt: r };
    } finally { cleanup(h); }
  };
  const first = await run({});
  assert.deepEqual([first.code, first.status], [0, "ok"]);
  assert.ok(first.out.some((l) => l.endsWith(`target=${TARGET} revision=${REVISION} artifact=${ARTIFACT} check=set`)));
  assert.deepEqual([first.receipt.kind, first.receipt.target, first.receipt.revision, first.receipt.artifact], ["keycheck", TARGET, REVISION, ARTIFACT],
    "the receipt names the target and the exact verified build");
  assert.equal(db.civilKeyCheck, CIVIL_KEY);
  const again = await run({});
  assert.deepEqual([again.code, again.status], [0, "ok"]);
  assert.ok(again.out.some((l) => l.endsWith("check=matched")));
  const other = await run({ M4_CIVIL_ID_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") });
  assert.deepEqual([other.code, other.status, other.rcode, other.err], [2, "refused", "civilKey", ["m4: refused.civilKey"]]);
  assert.equal(db.civilKeyCheck, CIVIL_KEY, "never replaced");
  // Not staging, or another target: refused before any check is set.
  const elsewhere = await run({ M4_TARGET_ID: "22222222-2222-4222-8222-222222222222" });
  assert.deepEqual([elsewhere.code, elsewhere.rcode], [2, "target"]);
  const noKey = await run({ M4_CIVIL_ID_ENCRYPTION_KEY: undefined });
  assert.deepEqual([noKey.code, noKey.rcode], [2, "contactKeys"]);
});

test("a keycheck refused for provenance names no build: an unverified revision or artifact is never bound", async () => {
  const h = harness({ db: { ...fakeDb(), civilKeyCheck: null }, provenance: { artifact: "f".repeat(64) } });
  try {
    assert.equal(await main(["keycheck"], h.deps), 2);
    const r = h.receipt("keycheck" as "plan");
    assert.deepEqual([r.status, r.code, r.revision, r.artifact, r.target], ["refused", "provenance", undefined, undefined, undefined]);
    assert.deepEqual(h.calls, []);
  } finally { cleanup(h); }
});

const PRINCIPALS = ["principal-secret-a", "principal-secret-b", "principal-secret-c"];
const promotedAs = (legacyId: string, email: "promoted" | "answered" | "mismatch"): ContactPromotionResult =>
  ({ kind: "promoted", legacyId, outcomes: { phone: "promoted", handle: "personWritten", civilId: "promoted", email } });

/** A real plan and accepted write through the harness, in `dir`; the target's staged set then matches it. */
async function acceptedWrite(db: FakeDb, dir: string): Promise<{ invocation: string; plan: string; contacts: string }> {
  const plan = await planId({ dir, db });
  const w = harness({ dir, db, env: { M4_EXPECTED_PLAN: plan } });
  assert.equal(await main(["write"], w.deps), 0);
  const r = w.receipt("write");
  db.staged = r.contacts!;
  return { invocation: w.invocation, plan, contacts: r.contacts! };
}

test("a write receipt binds the staged contact set and the digest key's fingerprint, never a value or the key", async () => {
  const db = fakeDb();
  const dir = mkdtempSync(path.join(tmpdir(), "m4-cli-"));
  try {
    const w = await acceptedWrite(db, dir);
    const r = JSON.parse(readFileSync(path.join(dir, "out", `${w.invocation}.write.receipt.json`), "utf8")) as M4Receipt;
    assert.match(r.contacts!, /^[0-9a-f]{64}$/);
    assert.equal(r.digestKey, digestKeyFingerprint(Buffer.from(DIGEST_KEY, "base64")));
    assert.notEqual(r.contacts, contactSetDigest([]), "the planned candidate's row is in the set");
    const text = JSON.stringify(r);
    assert.ok(![DIGEST_KEY, CIVIL_KEY, ...CONTACT_VALUES].some((v) => text.includes(v)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("promote consumes one accepted write and walks every pending principal under the writer lock, counts only", async () => {
  const db = { ...fakeDb(), pending: [...PRINCIPALS, "principal-secret-gone"] };
  db.promoted.set(PRINCIPALS[0]!, promotedAs("900000000031", "promoted"));
  db.promoted.set(PRINCIPALS[1]!, promotedAs("900000000032", "answered"));
  db.promoted.set(PRINCIPALS[2]!, promotedAs("900000000033", "mismatch"));
  // Unlinked meanwhile: still listed as pending, tried once, and the walk passes it.
  db.promoted.set("principal-secret-gone", { kind: "skipped", reason: "notLinked" });
  const dir = mkdtempSync(path.join(tmpdir(), "m4-cli-"));
  try {
    const w = await acceptedWrite(db, dir);
    const h = harness({ dir, db, env: { M4_ACCEPTED_WRITE: w.invocation, M4_EXPECTED_PLAN: w.plan } });
    assert.equal(await main(["promote"], h.deps), 0);
    const r = h.receipt("promote");
    assert.deepEqual([r.kind, r.status, r.target, r.revision, r.artifact, r.plan, r.acceptedWrite], ["promote", "ok", TARGET, REVISION, ARTIFACT, w.plan, w.invocation]);
    assert.deepEqual(r.promotion, { promoted: 3, skipped: { notLinked: 1 }, phone: { promoted: 3 }, handle: { personWritten: 3 },
      civilId: { promoted: 3 }, email: { promoted: 1, answered: 1, mismatch: 1 } });
    assert.deepEqual(h.calls, ["pending:-", "promote", "promote", "promote", "promote", "pending:principal-secret-gone"]);
    assert.equal(h.state.reads, 0, "no legacy read");
    assert.equal(h.state.locked, false, "no refresh lock needed");
    assert.equal(db.writer, null, "the writer lock is released");
    const seen = JSON.stringify(r) + h.out.join("\n") + h.err.join("\n");
    assert.ok(![...PRINCIPALS, "principal-secret", "9000000000", CIVIL_KEY, DIGEST_KEY].some((v) => seen.includes(v)), "no id, legacy id or key");
    assert.ok(h.out.includes(`m4 promote ok invocation=${h.invocation} target=${TARGET} revision=${REVISION} artifact=${ARTIFACT} write=${w.invocation} promoted=3`));
    assert.ok(h.out.includes("email answered=1 mismatch=1 promoted=1"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the walk advances past repeated and skipped principals: more than a batch of them never ends it early", async () => {
  const ids = Array.from({ length: PROMOTE_BATCH * 2 + 7 }, (_, i) => `p-${String(i).padStart(5, "0")}`);
  const db = { ...fakeDb(), pending: [...ids] };
  // Every one is skipped and stays pending, then one promotable principal sorts last.
  db.pending.push("z-last");
  db.promoted.set("z-last", promotedAs("900000000099", "promoted"));
  const dir = mkdtempSync(path.join(tmpdir(), "m4-cli-"));
  try {
    const w = await acceptedWrite(db, dir);
    const h = harness({ dir, db, env: { M4_ACCEPTED_WRITE: w.invocation, M4_EXPECTED_PLAN: w.plan } });
    assert.equal(await main(["promote"], h.deps), 0);
    const r = h.receipt("promote");
    assert.deepEqual([r.promotion!.promoted, r.promotion!.skipped], [1, { notStaged: ids.length }]);
    assert.equal(h.calls.filter((c) => c === "promote").length, ids.length + 1, "every principal tried exactly once");
    assert.equal(h.calls.filter((c) => c.startsWith("pending:")).length, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("promote is refused before any promotion without an accepted same-target write, its key, its staged set, the schema, civil key and writer lock", async () => {
  const otherDigest = Buffer.alloc(32, 7).toString("base64");
  type Case = [string, (db: FakeDb, w: { invocation: string; plan: string }) => { env?: Record<string, string | undefined>; db?: Partial<FakeDb>; opts?: HarnessOptions; receipt?: (r: Record<string, unknown>) => void }, string];
  const cases: Case[] = [
    ["unverified build", () => ({ opts: { provenance: { artifact: "f".repeat(64) } } }), "provenance"],
    ["no accepted write named", () => ({ env: { M4_ACCEPTED_WRITE: undefined } }), "writeConfig"],
    ["no expected plan", () => ({ env: { M4_EXPECTED_PLAN: undefined } }), "writeConfig"],
    ["an unknown write", () => ({ env: { M4_ACCEPTED_WRITE: "33333333-3333-4333-8333-333333333333" } }), "acceptedWrite"],
    ["another plan", () => ({ env: { M4_EXPECTED_PLAN: "9".repeat(64) } }), "acceptedWrite"],
    ["a write that did not pass", () => ({ receipt: (r) => { r.status = "refused_rows"; } }), "acceptedWrite"],
    ["a write still started", () => ({ receipt: (r) => { r.status = "started"; } }), "acceptedWrite"],
    ["a write to another target", () => ({ receipt: (r) => { r.target = "22222222-2222-4222-8222-222222222222"; } }), "acceptedWrite"],
    ["a write by another build", () => ({ receipt: (r) => { r.artifact = "d".repeat(64); } }), "acceptedWrite"],
    ["a write receipt without the contact set", () => ({ receipt: (r) => { delete r.contacts; } }), "acceptedWrite"],
    ["a different digest key", () => ({ env: { M4_CONTACT_DIGEST_KEY: otherDigest } }), "digestKey"],
    ["staged rows not from that write", () => ({ db: { staged: "1".repeat(64) } }), "stagedInput"],
    ["not staging", () => ({ db: { marker: { environment: "production", targetId: TARGET } } }), "target"],
    ["no promotion schema", () => ({ db: { promotionReady: false } }), "promotionSchema"],
    ["no civil ID key", () => ({ env: { M4_CIVIL_ID_ENCRYPTION_KEY: undefined } }), "contactKeys"],
    ["no check provisioned", () => ({ db: { civilKeyCheck: null } }), "civilKey"],
    ["a wrong civil ID key", () => ({ env: { M4_CIVIL_ID_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") } }), "civilKey"],
    ["another writer", () => ({ db: { writer: {} } }), "writerBusy"],
  ];
  for (const [label, make, code] of cases) {
    const db = { ...fakeDb(), pending: [...PRINCIPALS] };
    const dir = mkdtempSync(path.join(tmpdir(), "m4-cli-"));
    try {
      const w = await acceptedWrite(db, dir);
      const c = make(db, w);
      if (c.receipt) {
        const file = path.join(dir, "out", `${w.invocation}.write.receipt.json`);
        const r = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        c.receipt(r);
        writeFileSync(file, JSON.stringify(r));
      }
      Object.assign(db, c.db ?? {});
      const h = harness({ ...c.opts, dir, db, env: { M4_ACCEPTED_WRITE: w.invocation, M4_EXPECTED_PLAN: w.plan, ...c.env } });
      assert.equal(await main(["promote"], h.deps), 2, label);
      const r = h.receipt("promote");
      assert.deepEqual([r.status, r.code, h.err], ["refused", code, [`m4: refused.${code}`]], label);
      assert.ok(!h.calls.some((x) => x === "promote" || x.startsWith("pending:")), `${label}: nothing promoted`);
      if (code === "provenance") assert.deepEqual([r.revision, r.artifact, r.target], [undefined, undefined, undefined], "no unverified build is bound");
      assert.ok(![otherDigest, DIGEST_KEY, CIVIL_KEY].some((k) => JSON.stringify(r).includes(k)), label);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("a promote that fails part way publishes failed with the counts so far and the fixed code; a re-run finishes the rest", async () => {
  const db = { ...fakeDb(), pending: [...PRINCIPALS] };
  db.promoted.set(PRINCIPALS[0]!, promotedAs("900000000031", "promoted"));
  db.promoted.set(PRINCIPALS[1]!, new ContactPromotionError());
  db.promoted.set(PRINCIPALS[2]!, promotedAs("900000000033", "promoted"));
  const dir = mkdtempSync(path.join(tmpdir(), "m4-cli-"));
  try {
    const w = await acceptedWrite(db, dir);
    const env = { M4_ACCEPTED_WRITE: w.invocation, M4_EXPECTED_PLAN: w.plan };
    const h = harness({ dir, db, env });
    assert.equal(await main(["promote"], h.deps), 1);
    const r = h.receipt("promote");
    assert.deepEqual([r.status, r.code, r.promotion?.promoted, r.unconfirmed], ["failed", "m1.contact.promotionFailed", 1, undefined]);
    assert.deepEqual(h.err, ["m4: m1.contact.promotionFailed"]);
    assert.equal(db.writer, null);
    db.promoted.set(PRINCIPALS[1]!, promotedAs("900000000032", "promoted"));
    const again = harness({ dir, db, env });
    assert.equal(await main(["promote"], again.deps), 0);
    assert.equal(again.receipt("promote").promotion?.promoted, 2, "only the two not yet promoted");
    assert.deepEqual(db.pending, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const LINKS: LinkReport = { imported: 5, linked: 2, ids: { "link.unlinked": ["31", "40", "100"], "link.notImported": ["77"], "link.multiplePrincipals": ["40"], "link.contactTaken": [], "link.emailMismatch": ["31"] } };

test("linkreport reads the target only, writes ids to the private report and counts only to the receipt", async () => {
  const db = { ...fakeDb(), links: LINKS };
  const h = harness({ db, env: { M4_CONTACT_DIGEST_KEY: undefined, M4_CIVIL_ID_ENCRYPTION_KEY: undefined, M4_OPERATOR_ORG_ID: undefined } });
  try {
    assert.equal(await main(["linkreport"], h.deps), 0);
    assert.equal(h.state.reads, 0, "no legacy read");
    assert.equal(h.state.locked, false, "no refresh lock");
    assert.deepEqual(h.calls, ["linkReport"]);
    const r = h.receipt("linkreport");
    assert.deepEqual([r.kind, r.status, r.target, r.revision, r.artifact], ["linkreport", "ok", TARGET, REVISION, ARTIFACT]);
    assert.deepEqual(r.links, { imported: 5, linked: 2, rules: { "link.unlinked": 3, "link.notImported": 1, "link.multiplePrincipals": 1, "link.contactTaken": 0, "link.emailMismatch": 1 } });
    for (const id of ["31", "40", "100", "77"]) assert.ok(!JSON.stringify(r).includes(`"${id}"`), "no legacy id in the receipt");
    const reportFile = path.join(h.file("out"), `${h.invocation}.linkreport.report.json`);
    assert.equal(statSync(reportFile).mode & 0o777, 0o600);
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    assert.deepEqual([report.imported, report.linked, report.ids], [5, 2, LINKS.ids]);
    assert.deepEqual([report.target, report.revision, report.artifact, report.invocation], [TARGET, REVISION, ARTIFACT, h.invocation]);
    assert.ok(h.out.some((l) => l === "links imported=5 linked=2 link.unlinked=3 link.notImported=1 link.multiplePrincipals=1 link.contactTaken=0 link.emailMismatch=1"));
    assert.ok(h.out.some((l) => l.startsWith(`m4 linkreport ok invocation=${h.invocation} target=${TARGET}`)));
    assert.ok(!h.out.join("\n").replaceAll(h.invocation, "<invocation>").includes("100"), "no legacy id in the log");
  } finally { cleanup(h); }
});

test("linkreport is refused before any read without a verified build, its target or its schema; a failed read is failed with a fixed code", async () => {
  const run = async (opts: HarnessOptions, expect: [number, string, string]) => {
    const h = harness(opts);
    try {
      assert.equal(await main(["linkreport"], h.deps), expect[0]);
      const r = h.receipt("linkreport");
      assert.deepEqual([r.status, r.code], [expect[1], expect[2]]);
      assert.equal(r.links, undefined);
      assert.ok(!existsSync(path.join(h.file("out"), `${h.invocation}.linkreport.report.json`)), "no report");
      return h.calls;
    } finally { cleanup(h); }
  };
  assert.deepEqual(await run({ env: { M4_TARGET_ID: "not-a-uuid" } }, [2, "refused", "destination"]), []);
  assert.deepEqual(await run({ env: { M4_DATABASE_URL: undefined } }, [2, "refused", "writeConfig"]), []);
  assert.deepEqual(await run({ provenance: { clean: false } }, [2, "refused", "provenance"]), []);
  assert.deepEqual(await run({ provenance: { artifact: "f".repeat(64) } }, [2, "refused", "provenance"]), []);
  assert.deepEqual(await run({ db: { ...fakeDb(), marker: { environment: "production", targetId: TARGET } } }, [2, "refused", "target"]), []);
  assert.deepEqual(await run({ env: { M4_TARGET_ID: "22222222-2222-4222-8222-222222222222" } }, [2, "refused", "target"]), []);
  assert.deepEqual(await run({ db: { ...fakeDb(), linkReportReady: false } }, [2, "refused", "schema"]), []);
  assert.deepEqual(await run({ db: { ...fakeDb(), links: new LinkReportError() } }, [1, "failed", "m3.link.reportFailed"]), ["linkReport"]);
});

// doccheck (M-2). Synthetic objects; "Secret" marks a stored name that must never leave memory.
const crc32 = (bytes: Buffer) => {
  let c = 0xffffffff;
  for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type: string, data: Buffer) => {
  const b = Buffer.alloc(data.length + 12);
  b.writeUInt32BE(data.length); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4);
  return b;
};
const png = () => {
  const h = Buffer.alloc(13); h.writeUInt32BE(1, 0); h.writeUInt32BE(1, 4); h[8] = 8; h[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", h), pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0]))), pngChunk("IEND", Buffer.alloc(0))]);
};
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** M-4's fixture with document columns: the imported candidate 31 and the archived 32. */
function docSources(): M4Sources {
  const base = sources();
  return { ...base, candidate: [
    { ...base.candidate[0]!, candidate_personal_photo: "Secret-photo.png", candidate_resume: "Secret-cv.pdf", candidate_civil_photo_front: "../Secret.png" },
    { ...base.candidate[1]!, candidate_civil_photo_back: "Secret-archived.png" },
  ] };
}

/** Writes a refresh report with mirror, lock and table provenance into the harness directory. */
function withProvenance(dir: string, over: Record<string, unknown> = {}): string {
  writeFileSync(path.join(dir, "refresh.json"), JSON.stringify({ ...REFRESH, mirror: { serverId: MIRROR_ID },
    lock: path.join(dir, "lock"), tables: { candidate: 2, country: 0 }, ...over }));
  return dir;
}
const provenancedDir = (over?: Record<string, unknown>) => withProvenance(mkdtempSync(path.join(tmpdir(), "m4-cli-")), over);

test("doccheck reads the whole candidate table and each object once under the refresh lock, and publishes counts and the set digest only", async () => {
  const photo = png();
  const reads: string[] = [];
  let state!: Harness["state"];
  const bucket: LegacyObjectReader = {
    read: async (key) => {
      assert.equal(state.locked, true, "objects are read under the refresh lock");
      reads.push(key);
      return key === "photos/Secret-photo.png" ? { kind: "found", bytes: photo } : { kind: "missing" };
    },
  };
  const h = harness({ dir: provenancedDir(), rows: docSources(), bucket, env: { M4_DATABASE_URL: undefined, M4_CONTACT_DIGEST_KEY: undefined, M4_CIVIL_ID_ENCRYPTION_KEY: undefined } });
  state = h.state;
  try {
    assert.equal(await main(["doccheck"], h.deps), 0);
    assert.deepEqual(reads, ["candidate-profile-photos/Secret-photo.png", "photos/Secret-photo.png", "candidate-resume/Secret-cv.pdf"]);
    assert.deepEqual(h.calls, [], "no target is touched");
    assert.equal(h.state.locked, false);
    assert.equal(h.state.released, 1);
    const checked = [{ legacyId: "31", kind: "personal-photo" as const, key: "photos/Secret-photo.png", mime: "image/png" as const, size: photo.length, sha256: sha256(photo) }];
    const r = h.receipt("doccheck");
    assert.deepEqual([r.kind, r.status, r.revision, r.artifact, r.today], ["doccheck", "ok", REVISION, ARTIFACT, "2026-11-23"]);
    assert.deepEqual(r.refresh, { startedAt: REFRESH.startedAt, finishedAt: REFRESH.finishedAt, totalRows: 42 });
    assert.deepEqual(r.documents, { candidates: 2, mapped: 2, checked: 1, bytes: photo.length, set: documentSetDigest(checked),
      rules: { "document.badKey": 1, "document.sharedObject": 0, "document.missing": 1, "document.tooLarge": 0, "document.admission": 0, "document.readFailed": 0 } });
    assert.ok(!JSON.stringify(r).includes('"31"'), "no legacy id in the receipt");
    const reportFile = path.join(h.file("out"), `${h.invocation}.doccheck.report.json`);
    assert.equal(statSync(reportFile).mode & 0o777, 0o600);
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    assert.deepEqual(report.documents, [{ legacyId: "31", kind: "personal-photo", mime: "image/png", size: photo.length, sha256: sha256(photo) }]);
    assert.deepEqual(report.issues, [
      { rule: "document.badKey", legacyId: "31", field: "candidate_civil_photo_front" },
      { rule: "document.missing", legacyId: "31", field: "candidate_resume" },
    ]);
    assert.equal(report.set, r.documents!.set);
    const everything = [readFileSync(reportFile, "utf8"), JSON.stringify(r), h.out.join("\n"), h.err.join("\n")].join("\n");
    assert.ok(!everything.includes("Secret") && !everything.includes(SECRET), "no stored name, key or value leaves the run");
    assert.ok(h.out.some((l) => l.startsWith(`m4 doccheck ok invocation=${h.invocation} set=${r.documents!.set}`)));
  } finally { cleanup(h); }
});

test("doccheck is refused before any object is read without a verified build, its bucket setting, the lock, an ok refresh or the whole candidate table", async () => {
  const run = async (opts: HarnessOptions, code: string) => {
    let objects = 0;
    const h = harness({ dir: provenancedDir(), rows: docSources(), bucket: { read: async () => { objects++; return { kind: "missing" }; } }, ...opts });
    try {
      assert.equal(await main(["doccheck"], h.deps), 2);
      const r = h.receipt("doccheck");
      assert.deepEqual([r.status, r.code, r.documents], ["refused", code, undefined]);
      assert.equal(objects, 0, "no object read");
      assert.ok(!existsSync(path.join(h.file("out"), `${h.invocation}.doccheck.report.json`)), "no report");
      assert.equal(h.state.locked, false);
      return h.state.reads;
    } finally { cleanup(h); }
  };
  assert.equal(await run({ provenance: { clean: false } }, "provenance"), 0);
  assert.equal(await run({ env: { M4_ARTIFACT_DIGEST: "f".repeat(64) } }, "provenance"), 0);
  assert.equal(await run({ bucket: () => { throw new Error("m2.bucket.config"); } }, "bucketConfig"), 0);
  assert.equal(await run({ lockHeld: false }, "locked"), 0);
  const notOk = mkdtempSync(path.join(tmpdir(), "m4-cli-"));
  writeFileSync(path.join(notOk, "refresh.json"), JSON.stringify({ ...REFRESH, ok: false }));
  assert.equal(await run({ dir: notOk }, "refreshNotOk"), 0);
  // The table grew between the read and the second count.
  assert.ok(await run({ countDrift: 1 }, "ownershipIncomplete") > 0);
  // The report describes another generation: another lock file, another mirror server, another count.
  assert.equal(await run({ dir: provenancedDir({ lock: "/var/lock/other-refresh.lock" }) }, "lockMismatch"), 0);
  assert.equal(await run({ mirrorId: "00000000-0000-1000-8000-000000000000" }, "mirrorMismatch"), 1);
  assert.equal(await run({ dir: provenancedDir({ tables: { candidate: 3 } }) }, "staleCount"), 7);
});

test("doccheck against a refresh report without provenance runs as diagnostic only", async () => {
  // A report from before mirror, lock and table provenance: no mirror read, and the receipt says diagnostic.
  for (const over of [{ mirror: undefined }, { lock: undefined }, { tables: {} }, null]) {
    const dir = mkdtempSync(path.join(tmpdir(), "m4-cli-"));
    if (over) withProvenance(dir, over); else writeFileSync(path.join(dir, "refresh.json"), JSON.stringify(REFRESH));
    const sqls: string[] = [];
    const h = harness({ dir, rows: docSources() });
    try {
      const reader = h.deps.reader;
      const deps: CliDeps = { ...h.deps, reader: (env) => { const r = reader(env); return { rows: (sql, p) => { sqls.push(sql); return r.rows(sql, p); } }; } };
      assert.equal(await main(["doccheck"], deps), 0);
      const r = h.receipt("doccheck");
      assert.equal(r.documents!.diagnostic, true);
      assert.ok(!sqls.some((q) => q.includes("@@server_uuid")), "no mirror read without a recorded mirror");
      const report = JSON.parse(readFileSync(path.join(h.file("out"), `${h.invocation}.doccheck.report.json`), "utf8"));
      assert.equal(report.diagnostic, true);
      assert.ok(h.out.some((l) => l.includes(" diagnostic=true ")));
    } finally { cleanup(h); }
  }
  // With provenance the flag is absent.
  const h = harness({ dir: provenancedDir(), rows: docSources() });
  try {
    assert.equal(await main(["doccheck"], h.deps), 0);
    assert.equal(h.receipt("doccheck").documents!.diagnostic, undefined);
  } finally { cleanup(h); }
});

test("doccheck turns a failed object read into a counted issue, and a failed legacy read into a fixed failure", async () => {
  const h = harness({ dir: provenancedDir(), rows: docSources(), bucket: { read: async () => { throw new Error("Secret detail"); } } });
  try {
    assert.equal(await main(["doccheck"], h.deps), 0);
    assert.equal(h.receipt("doccheck").documents!.rules["document.readFailed"], 2);
  } finally { cleanup(h); }
  const broken = harness({ rows: docSources() });
  try {
    const deps: CliDeps = { ...broken.deps, reader: () => ({ rows: async (sql: string) => {
      if (sql.includes("COUNT(*)")) return [{ n: 2 }];
      if (sql.endsWith("`candidate`")) return docSources().candidate;
      throw new Error("Secret detail");
    } }) };
    assert.equal(await main(["doccheck"], deps), 1);
    const r = broken.receipt("doccheck");
    assert.deepEqual([r.status, r.code], ["failed", "m2.read.country"]);
    assert.ok(!broken.err.join("\n").includes("Secret"));
  } finally { cleanup(broken); }
});
