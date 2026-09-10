// SHU-63 — single-run activation: bindings, fail-closed matrix, and mutations.
//
// The committed `enable_dispatch: false` and its existing assertions are NOT
// weakened by this mechanism: an activation substitutes for the COMMITTED flag for
// one bounded run and never for the runtime ENABLE_DISPATCH switch. Every test here
// asserts a refusal as hard as it asserts an arm, because a mechanism whose only
// observable behaviour is "sometimes allows dispatch" is indistinguishable from a
// hole.
//
// The target and contract values are READ FROM the committed config rather than
// hardcoded, so this suite follows the configuration instead of pinning a second,
// silently-diverging copy of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ACTIVATION_ID_RE,
  MAX_ACTIVATION_WINDOW_MS,
  SINGLE_RUN_ACTIVATION_KEYS,
  parseActivationArgs,
  renderActivationLine,
  singleRunActivationStatus,
  validateActivationRecord,
  activationAllowsTarget,
} from "../single-run-activation.mjs";
import { dispatchEnabledFor, main } from "../reconcile.mjs";

const COORDINATOR_DIR = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_PATH = join(COORDINATOR_DIR, "config.json");
const COMMITTED = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const TARGET = COMMITTED.dispatch_scope.issue_ids[0];
const CONTRACT = COMMITTED.fixture_lane.authorization_ref;
const OTHER_ISSUE = "SHU-999";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const OTHER_REVISION = "fedcba9876543210fedcba9876543210fedcba98";
const NOW = new Date("2026-09-10T12:00:00.000Z");

function makeFile(content, mode = 0o600) {
  const dir = fs.mkdtempSync(join(tmpdir(), "shu63-activation-"));
  const file = join(dir, "activation.json");
  if (content !== null) {
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
    fs.chmodSync(file, mode);
  }
  return { dir, file };
}

function record(over = {}) {
  return {
    activation_id: "shu63-fixture-run-0001",
    target_issue_id: TARGET,
    authorization_ref: CONTRACT,
    coordinator_revision: REVISION,
    slots: 1,
    expires_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    ...over,
  };
}

// Compute a status for a record written to a real file, then clean up.
function statusOf(over = {}, opts = {}) {
  const { dir, file } = makeFile(record(over), opts.mode ?? 0o600);
  try {
    return singleRunActivationStatus({
      filePath: file,
      config: opts.config ?? COMMITTED,
      receipts: opts.receipts ?? [],
      now: opts.now ?? NOW,
      // "gitHead" in opts, not ?? — an explicit null must stay null so the
      // unresolvable-revision case is actually exercised.
      gitHead: "gitHead" in opts ? opts.gitHead : REVISION,
      io: opts.io,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The runtime switch, as the operator sets it for the run window.
const SWITCH_ON = { ENABLE_DISPATCH: "true" };
const NO_SWITCH = {};

// ---------------------------------------------------------------------------
// The default path is untouched
// ---------------------------------------------------------------------------

test("SHU-63 activation ABSENT: the committed gates decide exactly as before", () => {
  // The 5-combination truth table, re-asserted with the new third argument present
  // in the signature: behaviour when no activation is supplied must not drift.
  const cfgF = { enable_dispatch: false, max_dispatch: 1 };
  const cfgT = { enable_dispatch: true, max_dispatch: 1 };
  const combos = [
    ["config:false env:unset", cfgF, {}, false],
    ["config:false env:true", cfgF, SWITCH_ON, false],
    ["config:true env:unset", cfgT, {}, false],
    ["config:true env:false", cfgT, { ENABLE_DISPATCH: "false" }, false],
    ["config:true env:true", cfgT, SWITCH_ON, true],
  ];
  for (const [label, config, env, expected] of combos) {
    assert.equal(dispatchEnabledFor(env, config), expected, `${label} (no activation)`);
    // ...and identically when an activation object exists but is not armed.
    assert.equal(dispatchEnabledFor(env, config, { state: "absent" }), expected, `${label} (activation absent)`);
    assert.equal(dispatchEnabledFor(env, config, { state: "refused", reason: "x" }), expected, `${label} (activation refused)`);
  }
  assert.equal(
    singleRunActivationStatus({ filePath: null, config: COMMITTED }).state,
    "absent",
    "no --activation means the mechanism is not in play at all",
  );
  assert.equal(renderActivationLine({ state: "absent" }), "activation=absent (committed gates only)");
});

test("SHU-63 activation: the committed config still carries enable_dispatch: false", () => {
  // The mechanism exists precisely so this stays true. If a future change flips it,
  // this assertion and the two pre-existing ones fail together — which is the point.
  assert.equal(COMMITTED.enable_dispatch, false);
});

test("SHU-63 activation ARMED: arms one run, and still requires the runtime switch", () => {
  const status = statusOf();
  assert.equal(status.state, "armed", status.reason ?? "");
  assert.equal(status.target_issue_id, TARGET);
  assert.equal(status.slots, 1);

  // Armed + runtime switch, with the committed flag false: dispatch runs.
  assert.equal(dispatchEnabledFor(SWITCH_ON, COMMITTED, status), true, "armed activation opens the committed gate for this run");
  // Armed WITHOUT the runtime switch: still closed. A forgotten activation file on
  // disk cannot arm anything by itself.
  assert.equal(dispatchEnabledFor(NO_SWITCH, COMMITTED, status), false, "the runtime switch is still required");
  assert.match(renderActivationLine(status), /^activation=ARMED /);
});

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

test("SHU-63 activation argv: absent, accepted, and refused shapes", () => {
  assert.deepEqual(parseActivationArgs([]), { path: null, error: null });
  assert.deepEqual(parseActivationArgs(["--activation", "/tmp/a.json"]), { path: "/tmp/a.json", error: null });
  assert.deepEqual(parseActivationArgs(["--activation=/tmp/a.json"]), { path: "/tmp/a.json", error: null });
  // A typo must not silently run with a weaker configuration than the operator asked for.
  assert.match(parseActivationArgs(["--activation"]).error, /requires a file path/);
  assert.match(parseActivationArgs(["--activation="]).error, /requires a file path/);
  assert.match(parseActivationArgs(["--activation", "--force"]).error, /requires a file path/);
  assert.match(parseActivationArgs(["--activation", "/a", "--activation", "/b"]).error, /more than once/);
  assert.match(parseActivationArgs(["--dry-run"]).error, /unexpected argument/);
  assert.match(parseActivationArgs(["--activation", "/a", "extra"]).error, /unexpected argument/);
});

// ---------------------------------------------------------------------------
// Every binding fails closed
// ---------------------------------------------------------------------------

test("SHU-63 activation: missing, malformed, stale, replayed, wrong-target, wrong-revision all fail closed", () => {
  const cases = [
    ["file missing", () => {
      const dir = fs.mkdtempSync(join(tmpdir(), "shu63-missing-"));
      try {
        return singleRunActivationStatus({ filePath: join(dir, "nope.json"), config: COMMITTED, now: NOW, gitHead: REVISION });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }],
    ["path is a directory", () => {
      const dir = fs.mkdtempSync(join(tmpdir(), "shu63-dir-"));
      try {
        return singleRunActivationStatus({ filePath: dir, config: COMMITTED, now: NOW, gitHead: REVISION });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }],
    ["path is a symlink", () => {
      const { dir, file } = makeFile(record());
      const link = join(dir, "link.json");
      fs.symlinkSync(file, link);
      try {
        return singleRunActivationStatus({ filePath: link, config: COMMITTED, now: NOW, gitHead: REVISION });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }],
    ["group/world readable (0644)", () => statusOf({}, { mode: 0o644 })],
    ["world readable (0604)", () => statusOf({}, { mode: 0o604 })],
    ["group writable (0660)", () => statusOf({}, { mode: 0o660 })],
    ["not JSON", () => {
      const { dir, file } = makeFile("this is not json {");
      try {
        return singleRunActivationStatus({ filePath: file, config: COMMITTED, now: NOW, gitHead: REVISION });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }],
    ["JSON array, not object", () => {
      const { dir, file } = makeFile([record()]);
      try {
        return singleRunActivationStatus({ filePath: file, config: COMMITTED, now: NOW, gitHead: REVISION });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }],
    ["missing key", () => statusOf({ slots: undefined })],
    ["unreviewed extra key", () => statusOf({ force: true })],
    ["bad activation_id", () => statusOf({ activation_id: "short" })],
    ["non-canonical target", () => statusOf({ target_issue_id: "SHU-FIXTURE-001" })],
    ["bad authorization_ref", () => statusOf({ authorization_ref: "free text approval" })],
    ["wrong contract ref", () => statusOf({ authorization_ref: "FIXTURE-SOME-OTHER-CONTRACT" })],
    ["bad revision shape", () => statusOf({ coordinator_revision: "HEAD" })],
    ["wrong revision", () => statusOf({}, { gitHead: OTHER_REVISION })],
    ["revision unresolvable", () => statusOf({}, { gitHead: null, io: { revisionResolver: () => null } })],
    ["wrong target", () => statusOf({ target_issue_id: OTHER_ISSUE })],
    ["slots 2", () => statusOf({ slots: 2 })],
    ["slots 0", () => statusOf({ slots: 0 })],
    ["slots 1 but committed cap 2", () => statusOf({}, { config: { ...COMMITTED, max_dispatch: 2 } })],
    ["expired", () => statusOf({ expires_at: new Date(NOW.getTime() - 1000).toISOString() })],
    ["expiry beyond the reviewed window", () => statusOf({ expires_at: new Date(NOW.getTime() + MAX_ACTIVATION_WINDOW_MS + 60000).toISOString() })],
    ["not a timestamp", () => statusOf({ expires_at: "tomorrow" })],
    ["board-wide config (no scope)", () => statusOf({}, { config: { ...COMMITTED, dispatch_scope: undefined } })],
    ["scope of two issues", () => statusOf({}, { config: { ...COMMITTED, dispatch_scope: { issue_ids: [TARGET, OTHER_ISSUE] } } })],
    ["fixture lane inconsistent with scope", () => statusOf({}, { config: { ...COMMITTED, fixture_lane: { id: OTHER_ISSUE, authorization_ref: CONTRACT } } })],
    ["already spent (COMPLETED)", () => statusOf({}, { receipts: [{ issue_id: TARGET, stage: "COMPLETED" }] })],
    ["already spent (HOLD)", () => statusOf({}, { receipts: [{ issue_id: TARGET, stage: "HOLD" }] })],
  ];

  for (const [label, run] of cases) {
    const status = run();
    assert.equal(status.state, "refused", `${label}: must refuse (got ${status.state})`);
    assert.equal(status.valid, false, `${label}: must be invalid`);
    assert.ok(status.reason && status.reason.length > 0, `${label}: must name a reason`);
    // The refusal must be total: no configuration of the two existing gates may
    // turn a refused activation into an armed run.
    for (const config of [{ ...COMMITTED, enable_dispatch: false }, { ...COMMITTED, enable_dispatch: true }]) {
      assert.equal(dispatchEnabledFor(SWITCH_ON, config, status), config.enable_dispatch === true,
        `${label}: a refused activation must never arm dispatch by itself`);
    }
    assert.match(renderActivationLine(status), /^activation=REFUSED \(/);
  }
});

test("SHU-63 activation: one-use is an EPISODE — FAILED does not spend it, COMPLETED/HOLD do", () => {
  // The approved run contract is build -> BLOCK -> revision -> re-review -> PASS, so
  // a retryable FAILED attempt inside the episode must not kill the authorization...
  assert.equal(statusOf({}, { receipts: [{ issue_id: TARGET, stage: "FAILED" }] }).state, "armed");
  assert.equal(statusOf({}, { receipts: [{ issue_id: TARGET, stage: "RUNNING" }] }).state, "armed");
  assert.equal(statusOf({}, { receipts: [{ issue_id: TARGET, stage: "RESERVED" }] }).state, "armed");
  // ...while receipts belonging to another issue are irrelevant to this binding.
  assert.equal(statusOf({}, { receipts: [{ issue_id: OTHER_ISSUE, stage: "COMPLETED" }] }).state, "armed");
  // ...and once the episode has ended the activation can never arm again.
  assert.match(statusOf({}, { receipts: [{ issue_id: TARGET, stage: "COMPLETED" }] }).reason, /spent/);
  assert.match(statusOf({}, { receipts: [{ issue_id: TARGET, stage: "HOLD" }] }).reason, /spent/);
});

test("SHU-63 activation: the claim-time target check is narrow by construction", () => {
  const armed = statusOf();
  assert.equal(activationAllowsTarget(armed, TARGET), true);
  assert.equal(activationAllowsTarget(armed, OTHER_ISSUE), false);
  // No activation in play: the committed scope is the only boundary, unchanged.
  assert.equal(activationAllowsTarget({ state: "absent" }, OTHER_ISSUE), true);
  assert.equal(activationAllowsTarget(null, OTHER_ISSUE), true);
});

test("SHU-63 activation: the record shape is exactly the reviewed key set", () => {
  assert.equal(validateActivationRecord(record()).ok, true);
  for (const key of SINGLE_RUN_ACTIVATION_KEYS) {
    const missing = { ...record() };
    delete missing[key];
    assert.equal(validateActivationRecord(missing).ok, false, `${key} is required`);
  }
  assert.ok(ACTIVATION_ID_RE.test("shu63-fixture-run-0001"));
  assert.equal(ACTIVATION_ID_RE.test("has spaces"), false);
});

// ---------------------------------------------------------------------------
// Integration: the coordinator process itself
// ---------------------------------------------------------------------------

test("SHU-63 activation: an ABSENT activation leaves the coordinator an inert dry run", async () => {
  const out = [];
  const code = await main([], {}, {
    skipActivationPreflight: true,
    openPRsOverride: [],
    stdout: (s) => out.push(s),
    fetchImpl: async () => {
      throw new Error("no network expected on a disabled dry run");
    },
  });
  const text = out.join("\n");
  assert.equal(code, 0, "a disabled coordinator exits 0");
  assert.match(text, /DRY-RUN \(dispatch disabled, no writes\)/);
  assert.match(text, /activation=absent \(committed gates only\)/);
});

test("SHU-63 activation: the RUNNING revision is what bounds an activation, end to end", async () => {
  // No injected revision: the coordinator resolves its own checkout. The record
  // carries a placeholder revision, so this proves the binding is against the code
  // actually executing rather than against anything the activation declares.
  const { dir, file } = makeFile(record());
  const out = [];
  try {
    const code = await main(["--activation", file], SWITCH_ON, {
      skipActivationPreflight: true,
      openPRsOverride: [],
      stdout: (s) => out.push(s),
      fetchImpl: async () => {
        throw new Error("no network expected when the activation is refused");
      },
    });
    const text = out.join("\n");
    assert.equal(code, 2);
    assert.match(text, /single-run activation REFUSED \(activation is bound to revision 0123456789abcdef/);
    assert.match(text, /but this coordinator is [0-9a-f]{40}/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SHU-63 activation: a REFUSED activation exits 2, says why, and writes nothing", async () => {
  const { dir, file } = makeFile(record({ slots: 2 }));
  const out = [];
  try {
    const code = await main(["--activation", file], SWITCH_ON, {
      skipActivationPreflight: true,
      openPRsOverride: [],
      stdout: (s) => out.push(s),
      gitHead: REVISION, // bind to the record so the SLOTS refusal is the one under test
      fetchImpl: async () => {
        throw new Error("no network expected when the activation is refused");
      },
    });
    const text = out.join("\n");
    assert.equal(code, 2, "a refused activation is a refusal, not a quiet dry run");
    assert.match(text, /dispatch: PREVENTED — single-run activation REFUSED/);
    assert.match(text, /requests 2 slots/);
    assert.doesNotMatch(text, /RESERVED|dispatch: .* -> /, "no launch or receipt write may follow a refusal");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SHU-63 activation: an invalid flag shape is refused before anything runs", async () => {
  const out = [];
  const code = await main(["--activation"], SWITCH_ON, {
    skipActivationPreflight: true,
    openPRsOverride: [],
    stdout: (s) => out.push(s),
    fetchImpl: async () => {
      throw new Error("no network expected");
    },
  });
  assert.equal(code, 2);
  assert.match(out.join("\n"), /single-run activation REFUSED \(--activation requires a file path\)/);
});

// ---------------------------------------------------------------------------
// MUTATIONS — every guard above must be load-bearing
// ---------------------------------------------------------------------------

const MUTATION_PRELUDE = `
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as mod from MODULE_URL;
const COMMITTED = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const TARGET = COMMITTED.dispatch_scope.issue_ids[0];
const CONTRACT = COMMITTED.fixture_lane.authorization_ref;
const REV = ${JSON.stringify(REVISION)};
const NOW = new Date("2026-09-10T12:00:00.000Z");
function rec(over = {}) {
  return { activation_id: "shu63-fixture-run-0001", target_issue_id: TARGET, authorization_ref: CONTRACT,
           coordinator_revision: REV, slots: 1,
           expires_at: new Date(NOW.getTime() + 3600000).toISOString(), ...over };
}
function withFile(r, mode = 0o600) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shu63-mut-"));
  const file = path.join(dir, "activation.json");
  fs.writeFileSync(file, JSON.stringify(r));
  fs.chmodSync(file, mode);
  return file;
}
function status(over = {}, opts = {}) {
  return mod.singleRunActivationStatus({
    filePath: withFile(rec(over), opts.mode ?? 0o600),
    config: opts.config ?? COMMITTED,
    receipts: opts.receipts ?? [],
    now: NOW,
    gitHead: opts.gitHead ?? REV,
  });
}
const COMMITTED_CONFIG = COMMITTED;
const ENV_ON = { ENABLE_DISPATCH: "true" };
const ARMED = { state: "armed" };
`;

test("SHU-63 activation MUTATIONS: every binding, permission, expiry and gate guard is killed", () => {
  const mutations = [
    {
      name: "runtime switch dropped for the activation path",
      file: "reconcile.mjs",
      from: "  return envGate && activation?.state === \"armed\";",
      to: "  return activation?.state === \"armed\"; // SHU63-MUTATION-ENV",
      assertion: `assert.equal(mod.dispatchEnabledFor({}, COMMITTED_CONFIG, ARMED), false,
        "an armed activation still requires the runtime switch");`,
      failure: /an armed activation still requires the runtime switch/,
    },
    {
      name: "committed two-gate path dropped",
      file: "reconcile.mjs",
      from: "  if (config.enable_dispatch === true && envGate) return true; // committed path, unchanged",
      to: "  if (false) return true; // SHU63-MUTATION-COMMITTED",
      assertion: `assert.equal(mod.dispatchEnabledFor(ENV_ON, { enable_dispatch: true, max_dispatch: 1 }), true,
        "the committed two-gate path still enables dispatch");`,
      failure: /the committed two-gate path still enables dispatch/,
    },
    {
      name: "target binding removed",
      file: "single-run-activation.mjs",
      from: "  if (record.target_issue_id !== scopeIssue) {",
      to: "  if (false) { // SHU63-MUTATION-TARGET",
      assertion: `assert.equal(status({ target_issue_id: "SHU-999" }).state, "refused",
        "an activation cannot name a target outside the committed scope");`,
      failure: /an activation cannot name a target outside the committed scope/,
    },
    {
      name: "contract reference binding removed",
      file: "single-run-activation.mjs",
      from: "  if (fixtureLane.authorization_ref && record.authorization_ref !== fixtureLane.authorization_ref) {",
      to: "  if (false) { // SHU63-MUTATION-CONTRACT",
      assertion: `assert.equal(status({ authorization_ref: "FIXTURE-OTHER-CONTRACT-20260101" }).state, "refused",
        "an activation cannot present a different contract reference");`,
      failure: /an activation cannot present a different contract reference/,
    },
    {
      name: "revision binding removed",
      file: "single-run-activation.mjs",
      from: "  if (record.coordinator_revision !== revision) {",
      to: "  if (false) { // SHU63-MUTATION-REVISION",
      assertion: `assert.equal(status({}, { gitHead: "fedcba9876543210fedcba9876543210fedcba98" }).state, "refused",
        "an activation bound to another revision cannot arm this coordinator");`,
      failure: /an activation bound to another revision cannot arm this coordinator/,
    },
    {
      name: "slots binding removed (capacity could be widened)",
      file: "single-run-activation.mjs",
      from: "  if (record.slots !== 1) return refused(`activation requests ${record.slots} slots; a single-run activation is one slot`);",
      to: "  if (false) return refused(`activation requests ${record.slots} slots; a single-run activation is one slot`); // SHU63-MUTATION-SLOTS",
      assertion: `assert.equal(status({ slots: 2 }, { config: { ...COMMITTED_CONFIG, max_dispatch: 2 } }).state, "refused",
        "a single-run activation can never declare more than one slot");`,
      failure: /a single-run activation can never declare more than one slot/,
    },
    {
      name: "expiry wall removed",
      file: "single-run-activation.mjs",
      from: "  if (expiry <= at) return refused(",
      to: "  if (false) return refused(",
      assertion: `assert.equal(status({ expires_at: new Date(NOW.getTime() - 1000).toISOString() }).state, "refused",
        "an expired activation cannot arm anything");`,
      failure: /an expired activation cannot arm anything/,
    },
    {
      name: "expiry window bound removed",
      file: "single-run-activation.mjs",
      from: "  if (expiry - at > MAX_ACTIVATION_WINDOW_MS) {",
      to: "  if (false) { // SHU63-MUTATION-WINDOW",
      assertion: `assert.equal(status({ expires_at: new Date(NOW.getTime() + 30 * 24 * 3600 * 1000).toISOString() }).state, "refused",
        "an unbounded expiry window is refused");`,
      failure: /an unbounded expiry window is refused/,
    },
    {
      name: "one-use guard removed (replay allowed)",
      file: "single-run-activation.mjs",
      from: "  if (spent.length > 0) {",
      to: "  if (false) { // SHU63-MUTATION-SPENT",
      assertion: `assert.equal(status({}, { receipts: [{ issue_id: TARGET, stage: "COMPLETED" }] }).state, "refused",
        "a spent activation cannot be replayed");`,
      failure: /a spent activation cannot be replayed/,
    },
    {
      name: "file permission guard removed",
      file: "single-run-activation.mjs",
      from: "  if ((stat.mode & FORBIDDEN_MODE_BITS) !== 0) {",
      to: "  if (false) { // SHU63-MUTATION-PERMS",
      assertion: `assert.equal(status({}, { mode: 0o644 }).state, "refused",
        "a broadly readable activation file is refused");`,
      failure: /a broadly readable activation file is refused/,
    },
    {
      name: "unknown-key guard removed",
      file: "single-run-activation.mjs",
      from: "  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {",
      to: "  if (false) { // SHU63-MUTATION-KEYS",
      assertion: `assert.equal(mod.validateActivationRecord({ ...rec(), force: true }).ok, false,
        "an unreviewed extra key is refused");`,
      failure: /an unreviewed extra key is refused/,
    },
    {
      name: "board-wide guard removed",
      file: "single-run-activation.mjs",
      from: "  if (!Array.isArray(scopeIds) || scopeIds.length !== 1) {",
      to: "  if (!Array.isArray(scopeIds) || scopeIds.length < 1) { // SHU63-MUTATION-SCOPE",
      assertion: `assert.equal(status({}, { config: { ...COMMITTED_CONFIG, dispatch_scope: { issue_ids: [TARGET, "SHU-999"] } } }).state, "refused",
        "an activation requires a committed single-issue scope");`,
      failure: /an activation requires a committed single-issue scope/,
    },
  ];

  for (const mutation of mutations) {
    const tmp = fs.mkdtempSync(join(tmpdir(), "shu63-activation-mutant-"));
    try {
      fs.cpSync(COORDINATOR_DIR, tmp, { recursive: true });
      const target = join(tmp, mutation.file);
      const source = fs.readFileSync(target, "utf8");
      assert.ok(source.includes(mutation.from), `${mutation.name}: source marker exists`);
      const mutated = source.replace(mutation.from, mutation.to);
      assert.notEqual(mutated, source, `${mutation.name}: mutation landed`);
      fs.writeFileSync(target, mutated);

      const probePath = join(tmp, "shu63-mutant-guard.mjs");
      const prelude = MUTATION_PRELUDE
        .replace("MODULE_URL", JSON.stringify(pathToFileURL(mutation.file === "reconcile.mjs" ? join(tmp, "reconcile.mjs") : join(tmp, "single-run-activation.mjs")).href))
        .replace("CONFIG_PATH", JSON.stringify(join(tmp, "config.json")));
      fs.writeFileSync(probePath, `${prelude}\n${mutation.assertion}\n`);
      const child = spawnSync(process.execPath, [probePath], { encoding: "utf8", timeout: 30000 });
      assert.notEqual(child.status, 0, `${mutation.name}: guard must fail\n${child.stdout}\n${child.stderr}`);
      assert.match(`${child.stdout}\n${child.stderr}`, mutation.failure, `${mutation.name}: named assertion failed`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});
