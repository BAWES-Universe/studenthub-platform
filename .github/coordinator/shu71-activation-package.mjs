// SHU-71 reviewed activation-package state machine.
//
// This module never discovers authority and never generates a signing key. It
// accepts one exact signed package, verifies the separately reviewed trust
// anchor, and exposes bounded structured operations. Host and Linear effects
// are injected so every effect can be reviewed, tested and denied independently.
import { createHash, createPublicKey, verify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { loadShu71PublicKey, SHU71_PUBLIC_KEY_PATH } from "./shu71-public-key.mjs";
import { validateFixtureScopePolicy } from "./workspace-scope.mjs";

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
const FIXTURES = Object.freeze(["SHU-140", "SHU-254"]);
const SHU254_SEED = "6c9c14907189fe3af733969c3d8f3a2c4e21f9b0";
const PACKAGE_KEYS = Object.freeze([
  "kind", "activation_id", "coordinator_revision", "created_at", "expires_at",
  "slots", "stop_before_merge", "merge_authority", "fixtures", "reseed",
  "issue_transitions", "cleanup", "evidence", "activation", "signature",
]);

function exactObject(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

export function canonicalBytes(value, omitSignature = true) {
  const canonical = (entry) => Array.isArray(entry)
    ? entry.map(canonical)
    : entry && typeof entry === "object"
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, canonical(entry[key])]))
      : entry;
  const root = omitSignature && value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "signature"))
    : value;
  return Buffer.from(JSON.stringify(canonical(root)));
}

export function publicKeyFingerprint(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("trust anchor is not Ed25519");
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

function fail(code, detail, phase = "validation") {
  return { ok: false, state: "HALT", phase, code, detail };
}

export function validateAnchor(anchor, publicKeyPem, revision, publicKeyPath = SHU71_PUBLIC_KEY_PATH) {
  try { publicKeyPem = loadShu71PublicKey(publicKeyPath, publicKeyPem); }
  catch (error) { return fail(error.message.startsWith("ACT_PUBLIC_KEY_PATH:") ? "ACT_PUBLIC_KEY_PATH" : "ACT_TRUST_ANCHOR_MISMATCH", error.message); }
  if (!exactObject(anchor, ["version", "algorithm", "coordinator_revision", "spki_sha256", "state"])) {
    return fail("ACT_TRUST_ANCHOR_INVALID", "trust-anchor manifest shape is not exact");
  }
  if (anchor.state !== "ready") return fail("ACT_KEY_AUTHORITY_REQUIRED", "owner-approved public trust anchor is not provisioned");
  if (anchor.version !== "1.0.0" || anchor.algorithm !== "Ed25519" || !SHA.test(revision ?? "") || anchor.coordinator_revision !== revision
      || !SHA256.test(anchor.spki_sha256 ?? "") || typeof publicKeyPem !== "string") {
    return fail("ACT_TRUST_ANCHOR_INVALID", "trust anchor is malformed or bound to another revision");
  }
  try {
    if (publicKeyFingerprint(publicKeyPem) !== anchor.spki_sha256) {
      return fail("ACT_TRUST_ANCHOR_MISMATCH", "public key fingerprint differs from the reviewed anchor");
    }
  } catch (error) {
    return fail("ACT_TRUST_ANCHOR_INVALID", error.message);
  }
  return { ok: true };
}

function validateFixture(entry) {
  return exactObject(entry, ["issue_id", "linear_id", "branch", "seed_head", "lane"])
    && FIXTURES.includes(entry.issue_id)
    && UUID.test(entry.linear_id ?? "")
    && SHA.test(entry.seed_head ?? "")
    && entry.lane?.id === entry.issue_id
    && validateFixtureScopePolicy(entry.lane).ok;
}

function validateTransition(entry) {
  return exactObject(entry, ["issue_id", "linear_id", "before", "ready", "restore"])
    && FIXTURES.includes(entry.issue_id)
    && UUID.test(entry.linear_id ?? "")
    && exactObject(entry.before, ["state_id", "assignee_id"])
    && UUID.test(entry.before.state_id ?? "")
    && (entry.before.assignee_id === null || UUID.test(entry.before.assignee_id ?? ""))
    && exactObject(entry.ready, ["state_id", "assignee_id"])
    && UUID.test(entry.ready.state_id ?? "")
    && entry.ready.assignee_id === null
    && isDeepStrictEqual(entry.restore, entry.before);
}

function exactFixturePair(fixtures) {
  return Array.isArray(fixtures) && fixtures.length === 2
    && fixtures.every((entry) => validateFixture(entry))
    && isDeepStrictEqual([...fixtures.map((entry) => entry.issue_id)].sort(), [...FIXTURES]);
}

function verifySignature(pkg, publicKeyPem) {
  if (typeof pkg.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(pkg.signature)) return false;
  try {
    return verify(null, canonicalBytes(pkg), createPublicKey(publicKeyPem), Buffer.from(pkg.signature, "base64"));
  } catch {
    return false;
  }
}

function confinedEvidencePath(value, root, activationId) {
  const episodeRoot = `${root}/${activationId}`;
  return typeof value === "string" && path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && value.startsWith(`${episodeRoot}/`);
}

export function validateShu71Package({ pkg, anchor, publicKeyPem, publicKeyPath = SHU71_PUBLIC_KEY_PATH, revision, mainRevision, heads = {}, issues = [], seenActivationIds = [], now = new Date(), phase = "prepared" }) {
  if (!exactObject(pkg, PACKAGE_KEYS) || pkg.kind !== "shu71-activation-package-v1") {
    return fail("ACT_PACKAGE_MALFORMED", "package shape or kind is invalid");
  }
  const at = new Date(now).getTime();
  const created = Date.parse(pkg.created_at);
  const expiry = Date.parse(pkg.expires_at);
  const identityAndWindowValid = /^[A-Za-z0-9_-]{8,64}$/.test(pkg.activation_id ?? "")
      && SHA.test(pkg.coordinator_revision ?? "")
      && pkg.coordinator_revision === revision && pkg.coordinator_revision === mainRevision
      && ISO.test(pkg.created_at ?? "") && ISO.test(pkg.expires_at ?? "")
      && Number.isFinite(at) && Number.isFinite(created) && Number.isFinite(expiry)
      && created <= at && (phase === "revocation" || expiry > at) && expiry > created && expiry - created <= 43_200_000;
  if (!identityAndWindowValid) {
    return fail("ACT_ID_OR_EXPIRY_INVALID", "activation identity, exact revision, or twelve-hour window is invalid");
  }
  if (phase !== "revocation" && (!Array.isArray(seenActivationIds) || seenActivationIds.includes(pkg.activation_id))) {
    return fail("ACT_ACTIVATION_REPLAY", "activation identity is already present in retained evidence");
  }
  if (pkg.slots !== 2 || pkg.stop_before_merge !== true || pkg.merge_authority !== "none") {
    return fail("ACT_MANUAL_GATE_BYPASS", "package must grant two slots and no merge authority with stop-before-merge true");
  }
  if (!exactFixturePair(pkg.fixtures)) {
    return fail("ACT_WRONG_FIXTURE", "exact SHU-140 and SHU-254 fixture bindings are required");
  }
  if (pkg.fixtures.some((entry) => entry.branch !== `coordinator/${entry.issue_id}`)) {
    return fail("ACT_LANE_CROSS", "fixture branch and lane identity must not cross");
  }
  const byId = Object.fromEntries(pkg.fixtures.map((entry) => [entry.issue_id, entry]));
  if (byId["SHU-254"].seed_head !== SHU254_SEED) {
    return fail("ACT_STALE_SEED", "SHU-254 must remain bound to the reviewed seed head");
  }
  if (!exactObject(pkg.reseed, ["issue_id", "branch", "expected_parent", "expected_seed_head", "patch_sha256", "append_only", "force"])
      || pkg.reseed.issue_id !== "SHU-140" || pkg.reseed.branch !== "coordinator/SHU-140"
      || !SHA.test(pkg.reseed.expected_parent ?? "") || !SHA.test(pkg.reseed.expected_seed_head ?? "")
      || pkg.reseed.expected_seed_head === pkg.reseed.expected_parent || !SHA256.test(pkg.reseed.patch_sha256 ?? "")
      || pkg.reseed.append_only !== true || pkg.reseed.force !== false
      || byId["SHU-140"].seed_head !== pkg.reseed.expected_seed_head) {
    return fail("ACT_RESEED_NOT_APPEND_ONLY", "SHU-140 reseed must bind one non-forcing child of the retained head");
  }
  if (!Array.isArray(pkg.issue_transitions) || pkg.issue_transitions.length !== 2
      || pkg.issue_transitions.some((entry) => !validateTransition(entry))
      || !isDeepStrictEqual([...pkg.issue_transitions.map((entry) => entry.issue_id)].sort(), [...FIXTURES])) {
    return fail("ACT_PARTIAL_ARMING", "both fixture clear-and-restore transitions must be exact");
  }
  if (!exactObject(pkg.cleanup, ["worktree_root", "evidence_dir", "coordinator_uid", "worker_uid", "reviewer_uid", "identity_bound", "retain_evidence"])
      || pkg.cleanup.worktree_root !== "/srv/shu/worktrees" || pkg.cleanup.evidence_dir !== "/srv/shu/state/shu71-evidence"
      || pkg.cleanup.coordinator_uid !== 999 || pkg.cleanup.worker_uid !== 995 || pkg.cleanup.reviewer_uid !== 994
      || pkg.cleanup.identity_bound !== true || pkg.cleanup.retain_evidence !== true) {
    return fail("ACT_CLEANUP_POLICY_INVALID", "cleanup must be identity-bound and retain evidence");
  }
  if (!exactObject(pkg.evidence, ["journal_path", "archive_path", "append_only", "retain_on_failure"])
      || !confinedEvidencePath(pkg.evidence.journal_path, pkg.cleanup.evidence_dir, pkg.activation_id)
      || !confinedEvidencePath(pkg.evidence.archive_path, pkg.cleanup.evidence_dir, pkg.activation_id)
      || pkg.evidence.append_only !== true || pkg.evidence.retain_on_failure !== true) {
    return fail("ACT_EVIDENCE_POLICY_INVALID", "evidence paths must be confined, append-only and retained on failure");
  }
  if (!exactObject(pkg.activation, ["kind", "activation_id", "coordinator_revision", "slots", "expires_at", "stop_before_merge", "fixtures", "gates", "signature"])
      || !exactObject(pkg.activation?.gates, ["reviewed", "runtime"])
      || pkg.activation.kind !== "two-fixture-v1" || pkg.activation.activation_id !== pkg.activation_id
      || pkg.activation.coordinator_revision !== pkg.coordinator_revision || pkg.activation.expires_at !== pkg.expires_at
      || pkg.activation.slots !== 2 || pkg.activation.stop_before_merge !== true
      || pkg.activation.gates?.reviewed !== true || pkg.activation.gates?.runtime !== true
      || !Array.isArray(pkg.activation.fixtures) || pkg.activation.fixtures.length !== 2
      || pkg.activation.fixtures.some((fixture) => byId[fixture.issue_id]?.seed_head !== fixture.seed_head
        || fixture.branch !== byId[fixture.issue_id]?.branch || !isDeepStrictEqual(fixture.lane, byId[fixture.issue_id]?.lane))) {
    return fail("ACT_ENVELOPE_MISMATCH", "runtime envelope does not exactly project the reviewed package");
  }
  const anchorResult = validateAnchor(anchor, publicKeyPem, revision, publicKeyPath);
  if (!anchorResult.ok) return anchorResult;
  publicKeyPem = loadShu71PublicKey(publicKeyPath, publicKeyPem);
  if (!verifySignature(pkg, publicKeyPem)) return fail("ACT_FORGED_ENVELOPE", "package signature is absent, malformed, or invalid");
  if (!verifySignature(pkg.activation, publicKeyPem)) return fail("ACT_FORGED_ENVELOPE", "runtime activation envelope signature is invalid");

  for (const fixture of pkg.fixtures) {
    const issue = issues.find((entry) => entry.issue_id === fixture.issue_id && entry.linear_id === fixture.linear_id);
    if (!issue) return fail("ACT_WRONG_FIXTURE", `authoritative identity missing for ${fixture.issue_id}`);
    if (phase === "revocation") continue;
    const expectedHead = phase === "prepared" && fixture.issue_id === "SHU-140"
      ? pkg.reseed.expected_parent : fixture.seed_head;
    if (heads[fixture.branch] !== expectedHead) return fail("ACT_STALE_SEED", `${fixture.branch} differs from its ${phase} binding`);
  }
  return { ok: true, state: phase === "prepared" ? "PREPARED" : "VERIFIED", phase, activation_id: pkg.activation_id };
}

async function safelyRestore(pkg, io, changed) {
  const failures = [];
  for (const transition of [...pkg.issue_transitions].reverse()) {
    if (!changed.has(transition.issue_id)) continue;
    try {
      await io.updateIssue({ issue_id: transition.issue_id, linear_id: transition.linear_id, ...transition.restore });
      const observed = await io.readIssue(transition.issue_id);
      if (observed.state_id !== transition.restore.state_id || observed.assignee_id !== transition.restore.assignee_id) {
        failures.push(`${transition.issue_id}: restore verification mismatch`);
      }
    } catch (error) {
      failures.push(`${transition.issue_id}: ${error.message}`);
    }
  }
  return failures;
}

export async function runShu71Command(command, context) {
  const { pkg, io } = context;
  if (!["reseed", "activate", "revoke"].includes(command)) return fail("ACT_COMMAND_INVALID", "expected reseed, activate, or revoke", "command");
  if (command === "revoke") {
    try { await io.setRuntimeGate({ activation_id: pkg?.activation_id ?? null, enabled: false }); }
    catch (error) { return fail("ACT_REVOCATION_FAILED", `runtime gate could not be disabled: ${error.message}`, command); }
  }
  const phase = command === "reseed" ? "prepared" : command === "revoke" ? "revocation" : "seeded";
  const checked = validateShu71Package({ ...context, phase });
  if (!checked.ok) return checked;
  const append = async (event) => {
    try { await io.appendEvidence({ version: "1.0.0", activation_id: pkg.activation_id, at: new Date(context.now ?? Date.now()).toISOString(), ...event }); }
    catch (error) { return fail("ACT_EVIDENCE_WRITE_FAILED", error.message, command); }
    return null;
  };

  if (command === "reseed") {
    let result;
    try { result = await io.appendReseed(structuredClone(pkg.reseed)); }
    catch (error) {
      try { result = await io.observeReseed(structuredClone(pkg.reseed)); }
      catch { return fail("ACT_RESEED_FAILED", error.message, command); }
    }
    if (!exactObject(result, ["before", "after", "parent", "patch_sha256", "forced"])
        || result.before !== pkg.reseed.expected_parent || result.parent !== pkg.reseed.expected_parent
        || result.after !== pkg.reseed.expected_seed_head || result.patch_sha256 !== pkg.reseed.patch_sha256
        || result.forced !== false) return fail("ACT_RESEED_VERIFICATION_FAILED", "observed reseed is not the signed append-only operation", command);
    const evidenceFailure = await append({ event: "SHU140_RESEEDED", ...result });
    return evidenceFailure ?? { ok: true, state: "RESEEDED", phase: command, activation_id: pkg.activation_id, seed_head: result.after };
  }

  if (command === "activate") {
    const changed = new Set();
    let activationInstalled = false;
    let runtimeArmed = false;
    try {
      const journalFailure = await append({ event: "ACTIVATION_STARTED", transitions: pkg.issue_transitions });
      if (journalFailure) return journalFailure;
      for (const transition of pkg.issue_transitions) {
        const before = await io.readIssue(transition.issue_id);
        if (before.state_id !== transition.before.state_id || before.assignee_id !== transition.before.assignee_id) {
          throw Object.assign(new Error(`${transition.issue_id} prior state drift`), { code: "ACT_PRIOR_STATE_DRIFT" });
        }
        changed.add(transition.issue_id);
        await io.updateIssue({ issue_id: transition.issue_id, linear_id: transition.linear_id, ...transition.ready });
        const ready = await io.readIssue(transition.issue_id);
        if (ready.state_id !== transition.ready.state_id || ready.assignee_id !== null) {
          throw Object.assign(new Error(`${transition.issue_id} clear/ready verification failed`), { code: "ACT_PARTIAL_ARMING" });
        }
      }
      activationInstalled = true;
      await io.installActivation(structuredClone(pkg.activation));
      runtimeArmed = true;
      await io.setRuntimeGate({ activation_id: pkg.activation_id, enabled: true });
      const evidenceFailure = await append({ event: "ACTIVATED", fixtures: FIXTURES, stop_before_merge: true, merge_authority: "none" });
      if (evidenceFailure) throw Object.assign(new Error(evidenceFailure.detail), { code: evidenceFailure.code });
      return { ok: true, state: "ARMED", phase: command, activation_id: pkg.activation_id };
    } catch (error) {
      const rollback = [];
      if (runtimeArmed) try { await io.setRuntimeGate({ activation_id: pkg.activation_id, enabled: false }); } catch (gateError) { rollback.push(`runtime gate: ${gateError.message}`); }
      if (activationInstalled) try { await io.archiveActivation(pkg.activation_id); } catch (archiveError) { rollback.push(`activation archive: ${archiveError.message}`); }
      rollback.push(...await safelyRestore(pkg, io, changed));
      try { await append({ event: "ACTIVATION_HALTED", code: error.code ?? "ACT_PARTIAL_ARMING", rollback }); } catch { /* append() already normalizes */ }
      return fail(rollback.length ? "ACT_ROLLBACK_FAILED" : (error.code ?? "ACT_PARTIAL_ARMING"), `${error.message}${rollback.length ? `; ${rollback.join("; ")}` : ""}`, command);
    }
  }

  const failures = [];
  try { await io.archiveActivation(pkg.activation_id); } catch (error) { failures.push(`activation archive: ${error.message}`); }
  const changed = new Set(FIXTURES);
  failures.push(...await safelyRestore(pkg, io, changed));
  try {
    const cleanup = await io.cleanupFixtures({
      activation_id: pkg.activation_id,
      worktree_root: pkg.cleanup.worktree_root,
      allowed_owner_uids: [pkg.cleanup.coordinator_uid, pkg.cleanup.worker_uid, pkg.cleanup.reviewer_uid],
      identity_bound: true,
    });
    if (!cleanup || cleanup.failed !== 0 || cleanup.retained_evidence !== true) failures.push("fixture cleanup verification failed");
  } catch (error) { failures.push(`fixture cleanup: ${error.message}`); }
  const eventFailure = await append({ event: failures.length ? "REVOCATION_HALTED" : "REVOKED", failures, evidence_retained: true });
  if (eventFailure) failures.push(`evidence: ${eventFailure.detail}`);
  return failures.length
    ? fail("ACT_CLEANUP_FAILED", failures.join("; "), command)
    : { ok: true, state: "REVOKED", phase: command, activation_id: pkg.activation_id, evidence_retained: true };
}

export const SHU71_FIXED_SEEDS = Object.freeze({ "SHU-254": SHU254_SEED });
