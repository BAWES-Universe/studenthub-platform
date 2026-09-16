import { sign } from "node:crypto";
import { canonicalBytes, publicKeyFingerprint } from "../../shu71-activation-package.mjs";
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

export function harness(testKeys) {
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
