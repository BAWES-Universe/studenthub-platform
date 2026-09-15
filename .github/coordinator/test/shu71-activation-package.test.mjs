import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { sign } from "node:crypto";
import {
  canonicalBytes,
  publicKeyFingerprint,
  runShu71Command,
  validateShu71Package,
} from "../shu71-activation-package.mjs";

import { ephemeralPublicSource } from "./fixture/ephemeral-public-source.mjs";
const testKeys = ephemeralPublicSource();

const REVISION = "a".repeat(40);
const PARENT = "0d3b65a4ca7588905952a57086394f264c2e24d4";
const SHU140_SEED = "b".repeat(40);
const SHU254_SEED = "6c9c14907189fe3af733969c3d8f3a2c4e21f9b0";
const PATCH = "c".repeat(64);
const NOW = new Date("2026-09-15T10:00:00.000Z");
const TODO = "68ef4514-566d-4ea8-8040-d933575b99d0";
const BACKLOG = "d7847882-e3dc-42d3-8a81-4657d6161500";
const KHALID = "48918d3d-f843-483f-bb23-2ba6c7ace499";
const IDS = {
  "SHU-140": "3c2b8f0e-9608-477f-beb3-84d51b3dcb0f",
  "SHU-254": "8254e831-be6b-4d55-a99c-7f9437ac5981",
};

function harness() {
  const { privateKey, publicKey } = testKeys;
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const lanes = {
    "SHU-140": { id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905", note: "fixture",
      initial_build_paths: ["tools/fixture/scan-vacuous.mjs", "tools/fixture/test/scan-vacuous.test.mjs"],
      revision_paths: ["tools/fixture/scan-vacuous.mjs", "tools/fixture/test/scan-vacuous.test.mjs", "tools/fixture-conformance/scan-vacuous.expectations.mjs"],
      seeded_defect_path: "tools/fixture-conformance/scan-vacuous.expectations.mjs" },
    "SHU-254": { id: "SHU-254", authorization_ref: "SHU-254", note: "fixture",
      initial_build_paths: ["tools/fixture-2/scan-unawaited.mjs", "tools/fixture-2/test/scan-unawaited.test.mjs"],
      revision_paths: ["tools/fixture-2/scan-unawaited.mjs", "tools/fixture-2/test/scan-unawaited.test.mjs", "tools/fixture-2-conformance/scan-unawaited.expectations.mjs"],
      seeded_defect_path: "tools/fixture-2-conformance/scan-unawaited.expectations.mjs" },
  };
  const fixtures = [
    { issue_id: "SHU-140", linear_id: IDS["SHU-140"], branch: "coordinator/SHU-140", seed_head: SHU140_SEED, lane: lanes["SHU-140"] },
    { issue_id: "SHU-254", linear_id: IDS["SHU-254"], branch: "coordinator/SHU-254", seed_head: SHU254_SEED, lane: lanes["SHU-254"] },
  ];
  const activation = {
    kind: "two-fixture-v1", activation_id: "shu71-proof-20260915", coordinator_revision: REVISION,
    slots: 2, expires_at: "2026-09-15T20:00:00.000Z", stop_before_merge: true,
    fixtures: fixtures.map((entry) => ({ issue_id: entry.issue_id, branch: entry.branch, seed_head: entry.seed_head,
      lane: structuredClone(entry.lane) })), gates: { reviewed: true, runtime: true }, signature: "",
  };
  activation.signature = sign(null, canonicalBytes(activation), privateKey).toString("base64");
  const pkg = {
    kind: "shu71-activation-package-v1", activation_id: activation.activation_id, coordinator_revision: REVISION,
    created_at: "2026-09-15T09:00:00.000Z", expires_at: activation.expires_at, slots: 2,
    stop_before_merge: true, merge_authority: "none", fixtures,
    reseed: { issue_id: "SHU-140", branch: "coordinator/SHU-140", expected_parent: PARENT,
      expected_seed_head: SHU140_SEED, patch_sha256: PATCH, append_only: true, force: false },
    issue_transitions: [
      { issue_id: "SHU-140", linear_id: IDS["SHU-140"], before: { state_id: BACKLOG, assignee_id: KHALID },
        ready: { state_id: TODO, assignee_id: null }, restore: { state_id: BACKLOG, assignee_id: KHALID } },
      { issue_id: "SHU-254", linear_id: IDS["SHU-254"], before: { state_id: BACKLOG, assignee_id: null },
        ready: { state_id: TODO, assignee_id: null }, restore: { state_id: BACKLOG, assignee_id: null } },
    ],
    cleanup: { worktree_root: "/srv/shu/worktrees", evidence_dir: "/srv/shu/state/shu71-evidence",
      coordinator_uid: 999, worker_uid: 995, reviewer_uid: 994, identity_bound: true, retain_evidence: true },
    evidence: { journal_path: "/srv/shu/state/shu71-evidence/shu71-proof-20260915/journal.jsonl",
      archive_path: "/srv/shu/state/shu71-evidence/shu71-proof-20260915/activation.json", append_only: true, retain_on_failure: true },
    activation, signature: "",
  };
  pkg.signature = sign(null, canonicalBytes(pkg), privateKey).toString("base64");
  const anchor = { version: "1.0.0", algorithm: "Ed25519", provenance_revision: "e".repeat(40),
    spki_sha256: publicKeyFingerprint(publicKeyPem), state: "ready" };
  const issues = fixtures.map((entry) => ({ issue_id: entry.issue_id, linear_id: entry.linear_id }));
  const preparedHeads = { "coordinator/SHU-140": PARENT, "coordinator/SHU-254": SHU254_SEED };
  const seededHeads = { "coordinator/SHU-140": SHU140_SEED, "coordinator/SHU-254": SHU254_SEED };
  const context = { pkg, anchor, publicKeyPem, revision: REVISION, mainRevision: REVISION, heads: preparedHeads, issues, now: NOW };
  const states = new Map(pkg.issue_transitions.map((entry) => [entry.issue_id, structuredClone(entry.before)]));
  const calls = [];
  const io = {
    appendEvidence: async (event) => calls.push(["evidence", structuredClone(event)]),
    appendReseed: async (plan) => ({ before: plan.expected_parent, after: plan.expected_seed_head,
      parent: plan.expected_parent, patch_sha256: plan.patch_sha256, forced: false }),
    observeReseed: async (plan) => ({ before: plan.expected_parent, after: plan.expected_seed_head,
      parent: plan.expected_parent, patch_sha256: plan.patch_sha256, forced: false }),
    readIssue: async (id) => structuredClone(states.get(id)),
    updateIssue: async ({ issue_id, state_id, assignee_id }) => { calls.push(["update", issue_id, state_id, assignee_id]); states.set(issue_id, { state_id, assignee_id }); },
    installActivation: async (record) => calls.push(["install", record.activation_id]),
    setRuntimeGate: async (gate) => calls.push(["gate", gate.enabled]),
    archiveActivation: async (id) => calls.push(["archive", id]),
    cleanupFixtures: async (input) => { calls.push(["cleanup", input]); return { failed: 0, retained_evidence: true }; },
  };
  return { context, seededHeads, states, calls, io, privateKey };
}

function resign(h) {
  h.context.pkg.activation.signature = sign(null, canonicalBytes(h.context.pkg.activation), h.privateKey).toString("base64");
  h.context.pkg.signature = sign(null, canonicalBytes(h.context.pkg), h.privateKey).toString("base64");
}

test("SHU71_POSITIVE: reviewed package validates in prepared and seeded phases", () => {
  const h = harness();
  assert.equal(validateShu71Package({ ...h.context, phase: "prepared" }).state, "PREPARED");
  assert.equal(validateShu71Package({ ...h.context, heads: h.seededHeads, phase: "seeded" }).state, "VERIFIED");
});

test("SHU71_ACTIVATION_ID: malformed and previously retained identities HALT", () => {
  const malformed = harness(); malformed.context.pkg.activation_id = "short"; malformed.context.pkg.activation.activation_id = "short"; resign(malformed);
  assert.equal(validateShu71Package(malformed.context).code, "ACT_ID_OR_EXPIRY_INVALID");
  const replay = harness(); replay.context.seenActivationIds = [replay.context.pkg.activation_id];
  assert.equal(validateShu71Package(replay.context).code, "ACT_ACTIVATION_REPLAY");
});

test("SHU71_STALE_SEED: either lane drifting from its exact seed HALTs", () => {
  const h = harness();
  const result = validateShu71Package({ ...h.context, heads: { ...h.seededHeads, "coordinator/SHU-254": "d".repeat(40) }, phase: "seeded" });
  assert.equal(result.code, "ACT_STALE_SEED", "SHU71_STALE_SEED: drift must HALT");
});

test("SHU71_WRONG_FIXTURE: a substituted fixture HALTs", () => {
  const h = harness(); h.context.pkg.fixtures[1].issue_id = "SHU-255"; resign(h);
  assert.equal(validateShu71Package(h.context).code, "ACT_WRONG_FIXTURE", "SHU71_WRONG_FIXTURE: exact pair is load-bearing");
});

test("SHU71_LANE_CROSSING: swapping a fixture branch HALTs", () => {
  const h = harness(); h.context.pkg.fixtures[1].branch = "coordinator/SHU-140"; resign(h);
  assert.equal(validateShu71Package(h.context).code, "ACT_LANE_CROSS", "SHU71_LANE_CROSSING: branch binding is load-bearing");
});

test("SHU71_FORGED_ENVELOPE: package and runtime signatures are independently verified", () => {
  const tamper = (value) => `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
  const outer = harness(); outer.context.pkg.signature = tamper(outer.context.pkg.signature);
  assert.equal(validateShu71Package(outer.context).code, "ACT_FORGED_ENVELOPE", "SHU71_FORGED_ENVELOPE: outer signature");
  const inner = harness(); inner.context.pkg.activation.signature = tamper(inner.context.pkg.activation.signature);
  inner.context.pkg.signature = sign(null, canonicalBytes(inner.context.pkg), inner.privateKey).toString("base64");
  assert.equal(validateShu71Package(inner.context).code, "ACT_FORGED_ENVELOPE", "SHU71_FORGED_ENVELOPE: runtime signature");
});

test("SHU71_EXPIRED_WINDOW: expired or overlong approval HALTs", () => {
  const h = harness(); h.context.pkg.expires_at = "2026-09-15T09:59:59.000Z"; h.context.pkg.activation.expires_at = h.context.pkg.expires_at; resign(h);
  assert.equal(validateShu71Package(h.context).code, "ACT_ID_OR_EXPIRY_INVALID", "SHU71_EXPIRED_WINDOW: expiry is load-bearing");
});

test("SHU71_MANUAL_GATE_BYPASS: merge authority or absent stop gate HALTs", () => {
  const h = harness(); h.context.pkg.merge_authority = "squash"; resign(h);
  assert.equal(validateShu71Package(h.context).code, "ACT_MANUAL_GATE_BYPASS", "SHU71_MANUAL_GATE_BYPASS: merge authority forbidden");
});

test("SHU71_OWNER_KEY: committed unprovisioned anchor fails closed without generating a key", () => {
  const h = harness();
  const anchor = JSON.parse(fs.readFileSync(new URL("../shu71-trust-anchor.json", import.meta.url), "utf8"));
  anchor.state = "owner-authority-required"; // Preserve the pre-provisioning refusal control.
  assert.equal(validateShu71Package({ ...h.context, anchor }).code, "ACT_KEY_AUTHORITY_REQUIRED");
});

test("SHU71_RESEED: append-only SHU-140 reseed records exact retained-parent evidence", async () => {
  const h = harness();
  const result = await runShu71Command("reseed", { ...h.context, io: h.io });
  assert.equal(result.state, "RESEEDED");
  assert.ok(h.calls.some(([kind, event]) => kind === "evidence" && event.event === "SHU140_RESEEDED" && event.parent === PARENT));
});

test("SHU71_RESEED_RECOVERY: lost reseed response is recovered only from the exact signed result", async () => {
  const h = harness(); h.io.appendReseed = async () => { throw new Error("lost transport response"); };
  const result = await runShu71Command("reseed", { ...h.context, io: h.io });
  assert.equal(result.state, "RESEEDED");
  h.io.observeReseed = async (plan) => ({ before: plan.expected_parent, after: "d".repeat(40), parent: plan.expected_parent,
    patch_sha256: plan.patch_sha256, forced: false });
  const refused = await runShu71Command("reseed", { ...h.context, io: h.io });
  assert.equal(refused.code, "ACT_RESEED_VERIFICATION_FAILED");
});

test("SHU71_PARTIAL_ARMING: second-card failure restores the first and never leaves a gate armed", async () => {
  const h = harness(); h.context.heads = h.seededHeads;
  const update = h.io.updateIssue;
  h.io.updateIssue = async (input) => {
    if (input.issue_id === "SHU-254" && input.state_id === TODO) throw new Error("synthetic second-card refusal");
    return update(input);
  };
  const result = await runShu71Command("activate", { ...h.context, io: h.io });
  assert.equal(result.code, "ACT_PARTIAL_ARMING", "SHU71_PARTIAL_ARMING: partial activation must HALT");
  assert.deepEqual(h.states.get("SHU-140"), { state_id: BACKLOG, assignee_id: KHALID }, "SHU71_PARTIAL_ARMING: first fixture restored");
  assert.equal(h.calls.some(([kind, enabled]) => kind === "gate" && enabled === true), false, "SHU71_PARTIAL_ARMING: runtime gate never armed");
});

test("SHU71_PARTIAL_ARMING: ambiguous runtime-gate response is disabled, archived and restored", async () => {
  const h = harness(); h.context.heads = h.seededHeads;
  h.io.setRuntimeGate = async ({ enabled }) => { h.calls.push(["gate", enabled]); if (enabled) throw new Error("lost gate response"); };
  const result = await runShu71Command("activate", { ...h.context, io: h.io });
  assert.equal(result.code, "ACT_PARTIAL_ARMING");
  assert.deepEqual(h.calls.filter(([kind]) => kind === "gate"), [["gate", true], ["gate", false]]);
  assert.ok(h.calls.some(([kind]) => kind === "archive"));
  assert.deepEqual(h.states.get("SHU-140"), { state_id: BACKLOG, assignee_id: KHALID });
});

test("SHU71_ACTIVATE_REVOKE: exact states arm, revoke restores both, and evidence survives", async () => {
  const h = harness(); h.context.heads = h.seededHeads;
  const armed = await runShu71Command("activate", { ...h.context, io: h.io });
  assert.equal(armed.state, "ARMED");
  assert.equal(h.states.get("SHU-140").assignee_id, null);
  const revoked = await runShu71Command("revoke", { ...h.context, io: h.io });
  assert.equal(revoked.state, "REVOKED");
  assert.deepEqual(h.states.get("SHU-140"), { state_id: BACKLOG, assignee_id: KHALID });
  assert.deepEqual(h.states.get("SHU-254"), { state_id: BACKLOG, assignee_id: null });
  const cleanup = h.calls.find(([kind]) => kind === "cleanup")[1];
  assert.deepEqual(cleanup.allowed_owner_uids, [999, 995, 994]);
  assert.equal(cleanup.identity_bound, true);
  assert.ok(h.calls.some(([kind, event]) => kind === "evidence" && event.event === "REVOKED" && event.evidence_retained));
  assert.equal(Object.hasOwn(h.io, "merge"), false, "fixture driver has no merge capability");
});

test("SHU71_REVOKE_EXPIRED: revocation disables an expired episode and ignores expected result-head drift", async () => {
  const h = harness();
  h.context.pkg.expires_at = "2026-09-15T09:30:00.000Z";
  h.context.pkg.activation.expires_at = h.context.pkg.expires_at;
  resign(h);
  h.context.heads = { "coordinator/SHU-140": "d".repeat(40), "coordinator/SHU-254": "e".repeat(40) };
  const result = await runShu71Command("revoke", { ...h.context, io: h.io });
  assert.equal(result.state, "REVOKED", "expired authorization must still be safely revocable");
  assert.deepEqual(h.calls[0], ["gate", false], "revocation disables before any stale-state validation");
});

test("SHU71_FAILED_CLEANUP: cleanup ambiguity HALTs after disable and retains evidence", async () => {
  const h = harness(); h.context.heads = h.seededHeads;
  h.io.cleanupFixtures = async () => ({ failed: 1, retained_evidence: true });
  const result = await runShu71Command("revoke", { ...h.context, io: h.io });
  assert.equal(result.code, "ACT_CLEANUP_FAILED", "SHU71_FAILED_CLEANUP: failed cleanup must HALT");
  assert.deepEqual(h.calls.find(([kind]) => kind === "gate"), ["gate", false], "SHU71_FAILED_CLEANUP: disable happens first");
  assert.ok(h.calls.some(([kind, event]) => kind === "evidence" && event.event === "REVOCATION_HALTED"));
});

const MUTATIONS = [
  ["stale seed", "if (heads[fixture.branch] !== expectedHead)", "if (false)", "SHU71_STALE_SEED"],
  ["wrong fixture", "if (!exactFixturePair(pkg.fixtures))", "if (false)", "SHU71_WRONG_FIXTURE"],
  ["lane crossing", "if (pkg.fixtures.some((entry) => entry.branch !== `coordinator/${entry.issue_id}`))", "if (false)", "SHU71_LANE_CROSSING"],
  ["partial arming rollback", "rollback.push(...await safelyRestore(pkg, io, changed));", "if (false) rollback.push(...await safelyRestore(pkg, io, changed));", "SHU71_PARTIAL_ARMING"],
  ["forged envelope", "if (!verifySignature(pkg, publicKeyPem))", "if (false)", "SHU71_FORGED_ENVELOPE"],
  ["expired window", "if (!identityAndWindowValid)", "if (false)", "SHU71_EXPIRED_WINDOW"],
  ["failed cleanup", "if (!cleanup || cleanup.failed !== 0 || cleanup.retained_evidence !== true) failures.push(\"fixture cleanup verification failed\");", "if (false) failures.push(\"fixture cleanup verification failed\");", "SHU71_FAILED_CLEANUP"],
  ["manual-gate bypass", "if (pkg.slots !== 2 || pkg.stop_before_merge !== true || pkg.merge_authority !== \"none\")", "if (false)", "SHU71_MANUAL_GATE_BYPASS"],
];

for (const [name, from, to, pattern] of MUTATIONS) {
  test(`SHU71_MUTATION ${name}: named assertion kills removed guard`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu71-activation-mutation-"));
    try {
      fs.cpSync(new URL("../", import.meta.url), root, { recursive: true });
      const target = path.join(root, "shu71-activation-package.mjs");
      const source = fs.readFileSync(target, "utf8");
      assert.equal(source.split(from).length, 2, `${name}: mutation anchor must be unique`);
      fs.writeFileSync(target, source.replace(from, to));
      const { NODE_TEST_CONTEXT, ...env } = process.env;
      const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=^${pattern}:`, path.join(root, "test/shu71-activation-package.test.mjs")],
        { cwd: root, env, encoding: "utf8", timeout: 30_000 });
      const output = run.stdout + run.stderr;
      assert.equal(run.status, 1, `${name} survived or did not run:\n${output}`);
      assert.match(output, /AssertionError/, `${name}: must die on an assertion`);
      assert.match(output, new RegExp(pattern), `${name}: named assertion must identify the kill`);
      assert.doesNotMatch(output, /SyntaxError|TypeError|ERR_MODULE_NOT_FOUND/, `${name}: crash is not a kill`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

import { killExecutionMutant } from './fixture/execution-mutants.mjs';
const executionCases = ['MISSING_BINDING', 'WRONG_REVISION', 'FOREIGN_KEY', 'EXPIRED_AUTHORIZATION', 'CHECKOUT_DRIFT'];

test('EXEC_PACKAGE_POSITIVE: differing provenance and correctly signed execution proceeds', () => {
  const h = harness();
  assert.notEqual(h.context.anchor.provenance_revision, h.context.pkg.coordinator_revision, 'EXEC_PACKAGE_POSITIVE: provenance is independent');
  assert.equal(validateShu71Package(h.context).ok, true, 'EXEC_PACKAGE_POSITIVE: signed, current, matching execution proceeds');
});
for (const kind of executionCases) test(`EXEC_PACKAGE_${kind}: signed execution refusal`, () => {
  const h = harness();
  assert.equal(validateShu71Package(h.context).ok, true, `EXEC_PACKAGE_${kind}: positive control`);
  if (kind === 'MISSING_BINDING') {
    h.context.pkg.coordinator_revision = null;
    h.context.pkg.activation.coordinator_revision = null;
  }
  if (kind === 'WRONG_REVISION') h.context.mainRevision = 'b'.repeat(40);
  if (kind === 'CHECKOUT_DRIFT') {
    const observed = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    assert.equal(observed.status, 0, 'EXEC_CHECKOUT_EVIDENCE: read actual working clone HEAD');
    h.context.revision = observed.stdout.trim();
    assert.match(h.context.revision, /^[0-9a-f]{40}$/, 'EXEC_CHECKOUT_EVIDENCE: actual SHA');
  }
  if (kind === 'FOREIGN_KEY') h.context.publicKeyPem = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA' + Buffer.alloc(32, 1).toString('base64') + '\n-----END PUBLIC KEY-----\n';
  if (kind === 'EXPIRED_AUTHORIZATION') {
    h.context.pkg.expires_at = '2026-09-15T09:59:59.000Z';
    h.context.pkg.activation.expires_at = h.context.pkg.expires_at;
  }
  resign(h);
  assert.equal(validateShu71Package(h.context).ok, false, `EXEC_PACKAGE_${kind}: authorization must refuse`);
});

for (const kind of executionCases) test(`EXEC_PACKAGE_MUTANT_${kind}: valid mutant dies by named assertion`, () => {
  killExecutionMutant(kind, 'PACKAGE', `EXEC_PACKAGE_${kind}`, 'shu71-activation-package.test.mjs');
});

test('EXEC_PACKAGE_PROVENANCE_ONLY: signed provenance SHA cannot substitute for approved execution', () => {
  const h = harness();
  h.context.pkg.coordinator_revision = h.context.anchor.provenance_revision;
  h.context.pkg.activation.coordinator_revision = h.context.anchor.provenance_revision;
  resign(h);
  assert.equal(validateShu71Package(h.context).ok, false, 'EXEC_PACKAGE_PROVENANCE_ONLY: even a signed provenance SHA is not the approved execution');
});
