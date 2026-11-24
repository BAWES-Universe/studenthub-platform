import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { M4_SOURCES, planM4, type M4Sources, type M4Table, type M4Writers } from "../src/m4-run.js";
import { acceptWrite, acquireSharedLock, main, type CliDeps, type M4Receipt, type Provenance, type WriteTarget } from "../src/m4-cli.js";

// Synthetic legacy rows only. SECRET marks every value that must never reach a receipt or a log.
const SECRET = "Secret";
const REVISION = "a".repeat(40);
const ACTOR = "c".repeat(64);
const TARGET = "11111111-1111-4111-8111-111111111111";
const OPERATOR = "operator-org";
const ARTIFACT = "e".repeat(64);
const REFRESH = { ok: true, startedAt: "2026-11-23T01:00:00.000Z", finishedAt: "2026-11-23T01:05:00.000Z", totalRows: 42 };

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
    candidate: [{ candidate_id: 31, deleted: 0, candidate_name: `${SECRET} Person`, candidate_birth_date: "2010-11-23" },
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
}
const fakeDb = (): FakeDb => ({ marker: { environment: "staging", targetId: TARGET }, operators: new Set([OPERATOR]), schemaReady: true, writer: null, sessionLost: false });

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
  readonly receipt: (mode: "plan" | "write") => M4Receipt;
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
    ...opts.writers,
  };
  const target: WriteTarget = {
    marker: async () => db.marker,
    hasOperator: async (id) => db.operators.has(id),
    schemaReady: async () => db.schemaReady,
    claimWriter: async () => { if (db.writer && db.writer !== me) return false; db.writer = me; return true; },
    writers: () => {
      assert.equal(db.writer, me, "writers are used only by the lock holder");
      // Like the session-bound pool: every batch first checks the session still holds the lock.
      const fenced = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
        if (db.sessionLost || db.writer !== me) throw new Error("m4.writerLost");
        return f(...a);
      };
      return { catalogue: fenced(writers.catalogue), companies: fenced(writers.companies), brandLinks: fenced(writers.brandLinks), stores: fenced(writers.stores), contacts: fenced(writers.contacts), people: fenced(writers.people) };
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
        const table = /FROM `([a-z_]+)`$/.exec(sql)![1] as M4Table;
        return rows[table];
      },
    }),
    target: () => target,
    provenance: () => ({ head: REVISION, clean: true, artifact: ARTIFACT, ...opts.provenance }),
    now: () => new Date(opts.now ?? "2026-11-23T02:00:00.000Z"),
    log: (line) => out.push(line),
    error: (line) => {
      err.push(line);
    },
  };
  const receipt = (mode: "plan" | "write") => JSON.parse(readFileSync(path.join(file("out"), `${invocation}.${mode}.receipt.json`), "utf8")) as M4Receipt;
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
    assert.equal(r.steps.length, 13);
    assert.equal(r.today, "2026-11-23");
    // M-1 on the run date: exactly 16 that day, and an archived candidate reported by rule only.
    assert.deepEqual(r.steps.at(-1), { step: "candidate", legacy: 2, mapped: 1, rules: { "candidate.archived": 1 } });
    assert.deepEqual(r.steps.find((s) => s.step === "company_contact")!.rules, { "contact.access": 1 });
    assert.deepEqual(h.calls, []);
    const out = h.file("out");
    assert.deepEqual(readdirSync(out).sort(), [`${h.invocation}.claim`, `${h.invocation}.plan.receipt.json`, `${h.invocation}.plan.report.json`]);
    for (const f of readdirSync(out)) assert.equal(statSync(path.join(out, f)).mode & 0o777, 0o600, f);
    // The receipt and the log carry no legacy id or value; the private report keeps ids by rule.
    // The invocation is a random UUID, which can itself contain a fixture id such as "b-1"; it is
    // checked exactly above, so it is removed before searching for leaked ids.
    const shared = (readFileSync(path.join(out, `${h.invocation}.plan.receipt.json`), "utf8") + h.out.join("\n")).replaceAll(h.invocation, "<invocation>");
    for (const id of ["l-1", "l-2", "p-1", "b-1", "m-1", SECRET, "example.com"]) assert.ok(!shared.includes(id), id);
    const report = readFileSync(path.join(out, `${h.invocation}.plan.report.json`), "utf8");
    assert.ok(report.includes("l-2") && !report.includes(SECRET));
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
  const mapped = (rows: M4Sources) => { const p = planM4(rows, "2026-11-23"); return [p.people.people, p.catalogue.map((c) => c.items), p.companies.organizations, p.brandLinks.links, p.stores.stores, p.contacts.contacts]; };
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
    assert.equal(h.calls.length, 13);
    assert.equal(h.calls.at(-1), "candidate");
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
    assert.deepEqual(r.unconfirmed, ["store", "company_contact", "candidate"]);
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
    assert.deepEqual(r.unconfirmed, ["brand_company", "store", "company_contact", "candidate"]);
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
    assert.deepEqual(r.unconfirmed, ["brand_company", "store", "company_contact", "candidate"]);
    assert.ok(!h.calls.includes("store") && !h.calls.includes("company_contact"));
    assert.ok(!acceptWrite(r, h.invocation, expected, code));
  } finally { cleanup(h); }
});

test("a lock lost after the last batch still fails the attempt: exclusivity is re-checked before the outcome is published", async () => {
  const expected = await planId();
  const db = fakeDb();
  const h = harness({ env: { M4_EXPECTED_PLAN: expected }, db, writers: {
    people: async (rows) => { h.calls.push("candidate"); db.sessionLost = true; return ok(rows.length); },
  } });
  try {
    const code = await main(["write"], h.deps);
    assert.equal(code, 1);
    const r = h.receipt("write");
    assert.deepEqual([r.status, r.code, r.steps.length, r.unconfirmed], ["failed", "m4.writerLost", 13, []]);
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
