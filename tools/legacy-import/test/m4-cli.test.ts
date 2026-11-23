import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { M4_SOURCES, type M4Sources, type M4Table, type M4Writers } from "../src/m4-run.js";
import { acquireSharedLock, main, type CliDeps, type M4Receipt, type WriteTarget } from "../src/m4-cli.js";

// Synthetic legacy rows only. SECRET marks every value that must never reach a receipt or a log.
const SECRET = "Secret";
const REVISION = "a".repeat(40);
const ACTOR = "c".repeat(64);
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
  };
}

const ok = (n: number) => ({ inserted: n, unchanged: 0, conflicts: [], refused: [] });

interface Harness {
  readonly dir: string;
  readonly deps: CliDeps;
  readonly calls: string[];
  readonly out: string[];
  readonly err: string[];
  readonly state: { locked: boolean; released: number; closed: number; reads: number };
  readonly file: (name: string) => string;
  readonly json: (name: string) => M4Receipt;
}

function harness(opts: { env?: Record<string, string | undefined>; environment?: string | null; lockHeld?: boolean; writers?: Partial<M4Writers>; rows?: M4Sources } = {}): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "m4-cli-"));
  const file = (name: string) => path.join(dir, name);
  writeFileSync(file("refresh.json"), JSON.stringify(REFRESH));
  const calls: string[] = [], out: string[] = [], err: string[] = [];
  const state = { locked: false, released: 0, closed: 0, reads: 0 };
  const rows = opts.rows ?? sources();
  const writers: M4Writers = {
    catalogue: async (table, items) => { calls.push(`catalogue.${table}`); return { ...ok(items.length), merged: 0, adopted: 0 }; },
    companies: async (r) => { calls.push("company"); return ok(r.length); },
    brandLinks: async (r) => { calls.push("brand_company"); return ok(r.length); },
    stores: async (r) => { calls.push("store"); return ok(r.length); },
    contacts: async (r) => { calls.push("company_contact"); return ok(r.length); },
    ...opts.writers,
  };
  const target: WriteTarget = {
    environment: async () => (opts.environment === undefined ? "staging" : opts.environment),
    writers: () => writers,
    close: async () => { state.closed++; },
  };
  const deps: CliDeps = {
    env: {
      M4_REVISION: REVISION, LEGACY_REFRESH_REPORT: file("refresh.json"), LEGACY_REFRESH_LOCK: file("lock"),
      M4_REPORT_PATH: file("report.json"), M4_PLAN_RECEIPT: file("plan.json"), M4_WRITE_RECEIPT: file("write.json"),
      M4_IMPORT_ACTOR: ACTOR, M4_OPERATOR_ORG_ID: "00000000-0000-4000-8000-000000000001", M4_DATABASE_URL: "postgres://unused/x",
      ...opts.env,
    },
    lock: async () => {
      if (opts.lockHeld === false) return { held: false };
      state.locked = true;
      return { held: true, release: () => { state.locked = false; state.released++; } };
    },
    reader: () => ({
      rows: async (sql) => {
        // Every read happens with the lock held.
        assert.equal(state.locked, true);
        state.reads++;
        const table = /FROM `([a-z_]+)`$/.exec(sql)![1] as M4Table;
        return rows[table];
      },
    }),
    target: () => target,
    now: () => new Date("2026-11-23T02:00:00.000Z"),
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  };
  return { dir, deps, calls, out, err, state, file, json: (name) => JSON.parse(readFileSync(file(name), "utf8")) as M4Receipt };
}

async function planId(): Promise<string> {
  const h = harness();
  try {
    assert.equal(await main(["plan"], h.deps), 0);
    return h.json("plan.json").plan;
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
}

test("plan publishes a counts-only receipt with the plan identity, revision and refresh, under the lock", async () => {
  const h = harness();
  try {
    assert.equal(await main(["plan"], h.deps), 0);
    const r = h.json("plan.json");
    assert.equal(r.kind, "plan");
    assert.equal(r.status, "ok");
    assert.equal(r.revision, REVISION);
    assert.deepEqual(r.refresh, { startedAt: REFRESH.startedAt, finishedAt: REFRESH.finishedAt, totalRows: 42 });
    assert.match(r.plan, /^[0-9a-f]{64}$/);
    assert.equal(r.steps.length, 12);
    assert.deepEqual(h.calls, []);
    assert.equal(existsSync(h.file("write.json")), false);
    assert.equal(statSync(h.file("plan.json")).mode & 0o777, 0o600);
    assert.equal(statSync(h.file("report.json")).mode & 0o777, 0o600);
    // The receipt and the log carry no legacy id or value; the private report keeps the ids.
    const shared = readFileSync(h.file("plan.json"), "utf8") + h.out.join("\n");
    for (const id of ["l-1", "l-2", "p-1", "b-1", "m-1", SECRET, "example.com"]) assert.ok(!shared.includes(id), id);
    assert.deepEqual(r.steps.at(-1)!.rules, { "contact.access": 1 });
    // The private report keeps the ids by rule, still with no legacy value.
    const report = readFileSync(h.file("report.json"), "utf8");
    assert.ok(report.includes("l-2") && !report.includes(SECRET));
    assert.ok(h.out.includes(`m4 plan ok plan=${r.plan}`));
    assert.equal(h.state.released, 1);
    assert.ok(h.state.reads > 0);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("the plan identity follows the revision, the refresh and every row's digest", async () => {
  const base = await planId();
  assert.equal(await planId(), base);
  const variants: { env?: Record<string, string>; rows?: M4Sources; refresh?: object }[] = [
    { env: { M4_REVISION: "b".repeat(40) } },
    { refresh: { ...REFRESH, totalRows: 43 } },
    { rows: { ...sources(), company: [{ company_id: 7, parent_company_id: null, company_name: `${SECRET} Co renamed`, deleted: 0 }] } },
  ];
  for (const v of variants) {
    const h = harness({ env: v.env, rows: v.rows });
    try {
      if (v.refresh) writeFileSync(h.file("refresh.json"), JSON.stringify(v.refresh));
      assert.equal(await main(["plan"], h.deps), 0);
      assert.notEqual(h.json("plan.json").plan, base);
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  }
});

test("write imports in order only for the expected plan on a staging target, and its receipt says ok", async () => {
  const expected = await planId();
  const h = harness({ env: { M4_EXPECTED_PLAN: expected } });
  try {
    writeFileSync(h.file("write.json"), JSON.stringify({ status: "ok", plan: "older" }));
    assert.equal(await main(["write"], h.deps), 0);
    assert.equal(h.calls.at(-1), "company_contact");
    assert.equal(h.calls.length, 12);
    const r = h.json("write.json");
    assert.deepEqual([r.kind, r.status, r.plan, r.revision, r.code], ["write", "ok", expected, REVISION, undefined]);
    assert.deepEqual(r.steps.map((s) => s.step), h.calls);
    assert.equal(r.steps.at(-1)!.write!.inserted, 1);
    assert.ok(!readFileSync(h.file("write.json"), "utf8").includes("l-1"));
    assert.equal(statSync(h.file("write.json")).mode & 0o777, 0o600);
    assert.deepEqual([h.state.released, h.state.closed], [1, 1]);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("a write step with refused rows or conflicts ends refused_rows, exit 3, with counts only", async () => {
  const expected = await planId();
  const h = harness({ env: { M4_EXPECTED_PLAN: expected }, writers: {
    stores: async (rows) => ({ inserted: 0, unchanged: 0, conflicts: rows.map((r) => ({ legacyId: r.legacyId, existingDigest: "a".repeat(64), incomingDigest: "b".repeat(64) })), refused: [] }),
    contacts: async (rows) => ({ inserted: 0, unchanged: 0, conflicts: [], refused: rows.map((r) => ({ legacyId: r.legacyId, code: "no_organization" as const })) }),
  } });
  try {
    assert.equal(await main(["write"], h.deps), 3);
    const r = h.json("write.json");
    assert.equal(r.status, "refused_rows");
    assert.deepEqual(r.steps.at(-1)!.write!.refused, { no_organization: 1 });
    assert.equal(r.steps.find((s) => s.step === "store")!.write!.conflicts, 1);
    assert.ok(!readFileSync(h.file("write.json"), "utf8").includes("l-1"));
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("a late failure after earlier steps committed ends failed, naming those steps, and never leaves an earlier ok", async () => {
  const expected = await planId();
  const h = harness({ env: { M4_EXPECTED_PLAN: expected }, writers: {
    stores: async () => { throw new Error(`duplicate key value (${SECRET} Store)`); },
  } });
  try {
    writeFileSync(h.file("write.json"), JSON.stringify({ kind: "write", status: "ok", plan: expected }));
    assert.equal(await main(["write"], h.deps), 1);
    const r = h.json("write.json");
    assert.equal(r.status, "failed");
    assert.equal(r.code, "m4.failed");
    assert.equal(r.plan, expected);
    assert.deepEqual(r.steps.map((s) => s.step), h.calls); // the failing stores writer records no call
    assert.ok(r.steps.some((s) => s.step === "brand_company"));
    assert.ok(!r.steps.some((s) => s.step === "store" || s.step === "company_contact"));
    assert.deepEqual(h.err, ["m4: m4.failed"]);
    const shared = readFileSync(h.file("write.json"), "utf8") + h.err.join("\n") + h.out.join("\n");
    assert.ok(!shared.includes(SECRET));
    assert.deepEqual([h.state.released, h.state.closed], [1, 1]);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("the started receipt replaces any earlier receipt before the first write", async () => {
  const expected = await planId();
  let seen: M4Receipt | undefined;
  const h = harness({ env: { M4_EXPECTED_PLAN: expected } });
  const first = h.deps.target(h.deps.env).writers().catalogue;
  const writers: Partial<M4Writers> = { catalogue: async (...args) => { seen ??= h.json("write.json"); return first(...args); } };
  const h2 = harness({ env: { M4_EXPECTED_PLAN: expected, M4_WRITE_RECEIPT: h.file("write.json") }, writers });
  try {
    writeFileSync(h.file("write.json"), JSON.stringify({ kind: "write", status: "ok", plan: expected }));
    assert.equal(await main(["write"], h2.deps), 0);
    assert.equal(seen!.status, "started");
    assert.deepEqual(seen!.steps, []);
    assert.equal(seen!.plan, expected);
  } finally { rmSync(h.dir, { recursive: true, force: true }); rmSync(h2.dir, { recursive: true, force: true }); }
});

test("every refusal exits 2 before any write, publishes no receipt and releases what it took", async () => {
  const expected = await planId();
  const cases: { name: string; argv: string[]; opts: Parameters<typeof harness>[0]; refresh?: unknown; reads: boolean }[] = [
    { name: "usage", argv: [], opts: {}, reads: false },
    { name: "usage", argv: ["import"], opts: {}, reads: false },
    { name: "revision", argv: ["plan"], opts: { env: { M4_REVISION: "main" } }, reads: false },
    { name: "revision", argv: ["write"], opts: { env: { M4_REVISION: undefined, M4_EXPECTED_PLAN: expected } }, reads: false },
    { name: "writeConfig", argv: ["write"], opts: {}, reads: false },
    { name: "writeConfig", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected, M4_IMPORT_ACTOR: "x" } }, reads: false },
    { name: "writeConfig", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected, M4_OPERATOR_ORG_ID: "" } }, reads: false },
    { name: "writeConfig", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected, M4_DATABASE_URL: undefined } }, reads: false },
    { name: "locked", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected }, lockHeld: false }, reads: false },
    { name: "locked", argv: ["plan"], opts: { lockHeld: false }, reads: false },
    { name: "refreshNotOk", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected } }, refresh: { ...REFRESH, ok: false }, reads: false },
    { name: "refreshNotOk", argv: ["plan"], opts: {}, refresh: "not json", reads: false },
    { name: "planMismatch", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: "d".repeat(64) } }, reads: true },
    { name: "planMismatch", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected, M4_REVISION: "b".repeat(40) } }, reads: true },
    { name: "target", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected }, environment: null }, reads: true },
    { name: "target", argv: ["write"], opts: { env: { M4_EXPECTED_PLAN: expected }, environment: "production" }, reads: true },
  ];
  for (const c of cases) {
    const h = harness(c.opts);
    try {
      if (c.refresh !== undefined) writeFileSync(h.file("refresh.json"), typeof c.refresh === "string" ? c.refresh : JSON.stringify(c.refresh));
      assert.equal(await main(c.argv, h.deps), 2, `${c.name} ${c.argv.join(" ")}`);
      assert.deepEqual(h.err, [`m4: refused.${c.name}`]);
      assert.deepEqual(h.calls, []);
      for (const f of ["plan.json", "write.json", "report.json"]) assert.equal(existsSync(h.file(f)), false, `${c.name} ${f}`);
      assert.equal(h.state.reads > 0, c.reads, c.name);
      assert.equal(h.state.locked, false, c.name);
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  }
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
