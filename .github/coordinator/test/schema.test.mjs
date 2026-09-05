// validateReceipt tests — schema conformance + cross-field stage invariants.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReceipt, createReceipt, nextReceiptState, receiptCommentBody, parseReceiptCommentBody, STAGES } from "../reconcile.mjs";

const SHA = "c".repeat(40);

// A full, valid example receipt (post-ack RUNNING) — must validate.
function validRunning() {
  return {
    receipt_version: "1.0.0",
    issue_id: "SHU-123",
    attempt_id: "11111111-2222-4333-8444-555555555555",
    authorization_ref: "SHU-123",
    stage: "RUNNING",
    requested_worker: "codex-builder",
    worker_identity: "wa-session-abc",
    repo: "BAWES-Universe/studenthub-platform",
    branch: "coordinator/SHU-123",
    target_sha: SHA,
    external_run_id: "apirun_12345",
    adapter_status: "in_progress",
    timestamps: { reserved: "2026-09-05T00:00:00.000Z", launch: "2026-09-05T00:00:01.000Z", heartbeat: "2026-09-05T00:00:02.000Z", terminal: null },
    evidence_links: [],
    last_activity: "2026-09-05T00:00:02.000Z",
    notes: ["reserved (attempt 11111111-2222-4333-8444-555555555555)", "worker ack"],
  };
}

function assertInvalid(receipt, pattern, label) {
  const { valid, errors } = validateReceipt(receipt);
  assert.equal(valid, false, `${label}: expected invalid, got ${JSON.stringify(errors)}`);
  if (pattern) assert.match(errors.join("\n"), pattern, label);
}

test("full valid example (RUNNING) validates", () => {
  const { valid, errors } = validateReceipt(validRunning());
  assert.equal(valid, true, errors.join("; "));
});

test("createReceipt output (RESERVED) validates and carries all schema fields", () => {
  const { ok, receipt, errors } = createReceipt({
    issue_id: "SHU-7",
    authorization_ref: "SHU-7",
    requested_worker: "claude-verifier",
    repo: "BAWES-Universe/studenthub-platform",
    branch: "chore/coordinator-dry-run",
    target_sha: SHA,
    attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  assert.equal(ok, true, errors?.join("; "));
  for (const field of [
    "receipt_version", "issue_id", "attempt_id", "authorization_ref", "stage",
    "requested_worker", "worker_identity", "repo", "branch", "target_sha",
    "external_run_id", "adapter_status", "timestamps", "evidence_links",
    "last_activity", "notes",
  ]) {
    assert.ok(field in receipt, `missing field ${field}`);
  }
  assert.equal(validateReceipt(receipt).valid, true);
});

test("rejects: missing attempt_id", () => {
  const r = validRunning();
  delete r.attempt_id;
  assertInvalid(r, /missing required field "attempt_id"/, "missing attempt_id");
});

test("rejects: missing nullable-but-present fields (worker_identity, external_run_id, adapter_status)", () => {
  for (const field of ["worker_identity", "external_run_id", "adapter_status"]) {
    const r = validRunning();
    delete r[field];
    assertInvalid(r, new RegExp(`missing required field "${field}"`), `missing ${field}`);
  }
});

test("rejects: bad stage enum", () => {
  const r = validRunning();
  r.stage = "RESERVING";
  assertInvalid(r, /stage.*must be one of/, "bad stage");
});

test("rejects: free-text authorization_ref (not contract-bound)", () => {
  const r = validRunning();
  r.authorization_ref = "please dispatch this card now";
  assertInvalid(r, /not an approved contract ref/, "free-text authz");
  r.authorization_ref = "SHU-FIXTURE-001"; // fixture lane id is a placeholder, not a Linear ref
  assertInvalid(r, /not an approved contract ref/, "fixture-lane id is not a ref");
});

test("accepts: contract-bound FIXTURE-* refs", () => {
  for (const ref of ["FIXTURE-001", "FIXTURE-AUTHZ-DEFECT-2"]) {
    const r = validRunning();
    r.authorization_ref = ref;
    r.issue_id = "SHU-123";
    const { valid, errors } = validateReceipt(r);
    assert.equal(valid, true, `${ref}: ${errors?.join("; ")}`);
  }
});

test("rejects: malformed attempt_id (uuid required)", () => {
  const r = validRunning();
  r.attempt_id = "not-a-uuid";
  assertInvalid(r, /fails pattern/, "bad uuid");
});

test("rejects: worker_identity present while stage=RESERVED with no external_run_id (null is the only RESERVED value)", () => {
  const { receipt } = createReceipt({
    issue_id: "SHU-8",
    authorization_ref: "SHU-8",
    requested_worker: "codex-builder",
    repo: "BAWES-Universe/studenthub-platform",
    branch: "b",
    target_sha: SHA,
    attempt_id: "bbbbbbbb-2222-4333-8444-555555555555",
  });
  receipt.worker_identity = "sneaky-session";
  assertInvalid(receipt, /RESERVED must have worker_identity null/, "worker id at RESERVED");
  receipt.worker_identity = null;
  assert.equal(validateReceipt(receipt).valid, true); // null allowed
});

test("rejects: worker_identity set while external_run_id null (contradictory pair)", () => {
  const r = validRunning();
  r.external_run_id = null;
  assertInvalid(r, /contradictory/, "identity without run id");
});

test("rejects: external_run_id not apirun_-prefixed", () => {
  const r = validRunning();
  r.external_run_id = "run-12345";
  assertInvalid(r, /fails pattern/, "bad run id prefix");
});

test("rejects: adapter_status outside granular enum", () => {
  const r = validRunning();
  r.adapter_status = "done-ish";
  assertInvalid(r, /must be one of/, "bad adapter_status");
  r.adapter_status = null; // null while RUNNING is invalid too
  assertInvalid(r, /granular adapter_status/, "null adapter_status at RUNNING");
});

test("rejects: RUNNING without external_run_id (worker_identity may stay null until the poll supplies agent_id)", () => {
  const r = validRunning();
  r.external_run_id = null;
  assertInvalid(r, /requires external_run_id/, "null external_run_id at RUNNING");

  // worker_identity is OPTIONAL at RUNNING — never fabricated (GPT review #1).
  const noIdentity = validRunning();
  noIdentity.worker_identity = null;
  assert.equal(validateReceipt(noIdentity).valid, true, "RUNNING without worker_identity is valid (agent_id unknown until poll)");
});

test("rejects: COMPLETED without evidence_links (no callback, no COMPLETED)", () => {
  const r = validRunning();
  r.stage = "COMPLETED";
  r.adapter_status = "completed";
  r.timestamps.terminal = "2026-09-05T00:10:00.000Z";
  assertInvalid(r, /requires validated evidence_links/, "completed w/o evidence");
  r.evidence_links = ["https://github.com/BAWES-Universe/studenthub-platform/pull/1"];
  assert.equal(validateReceipt(r).valid, true);
});

test("accepts: FAILED with a run (post-acceptance) and FAILED pre-acceptance (no run)", () => {
  const withRun = validRunning();
  withRun.stage = "FAILED";
  withRun.adapter_status = "failed";
  withRun.timestamps.terminal = "2026-09-05T00:10:00.000Z";
  assert.equal(validateReceipt(withRun).valid, true);

  const pre = validRunning();
  pre.stage = "FAILED";
  pre.external_run_id = null;
  pre.worker_identity = null;
  pre.adapter_status = null;
  pre.timestamps.terminal = "2026-09-05T00:10:00.000Z";
  pre.notes = [...pre.notes, "run failed (rejected before run acceptance) (error code HTTP_429)"];
  assert.equal(validateReceipt(pre).valid, true);

  // worker_identity is OPTIONAL even post-acceptance (only the poll's agent_id
  // sets it — GPT review #1); FAILED-with-run without identity is valid as long
  // as the granular adapter_status is "failed".
  const noIdentity = validRunning();
  noIdentity.stage = "FAILED";
  noIdentity.worker_identity = null;
  noIdentity.adapter_status = "failed";
  noIdentity.timestamps.terminal = "2026-09-05T00:10:00.000Z";
  assert.equal(validateReceipt(noIdentity).valid, true, "FAILED with a run may have worker_identity null (agent_id unknown)");
});

test("rejects: RESERVED carrying a launch timestamp (reserve precedes launch)", () => {
  const { receipt } = createReceipt({
    issue_id: "SHU-9",
    authorization_ref: "SHU-9",
    requested_worker: "codex-builder",
    repo: "BAWES-Universe/studenthub-platform",
    branch: "b",
    target_sha: SHA,
    attempt_id: "cccccccc-2222-4333-8444-555555555555",
  });
  receipt.timestamps.launch = "2026-09-05T00:00:01.000Z";
  assertInvalid(receipt, /RESERVED must not carry a launch timestamp/, "launch ts at RESERVED");
});

test("rejects: terminal stages missing timestamps.terminal", () => {
  const r = validRunning();
  r.stage = "HOLD";
  r.adapter_status = "completed";
  r.timestamps.terminal = null;
  assertInvalid(r, /requires timestamps.terminal/, "HOLD w/o terminal ts");
});

test("rejects: bad target_sha format (40-hex bound head)", () => {
  const r = validRunning();
  r.target_sha = "abc";
  assertInvalid(r, /fails pattern/, "short sha");
});

test("rejects: requested_worker outside the family enum", () => {
  const r = validRunning();
  r.requested_worker = "random-worker";
  assertInvalid(r, /must be one of/, "bad requested_worker");
});

test("rejects: receipt_version drift", () => {
  const r = validRunning();
  r.receipt_version = "2.0.0";
  assertInvalid(r, /"1\.0\.0"/, "version drift");
});

test("rejects: non-object / null receipt", () => {
  assert.equal(validateReceipt(null).valid, false);
  assert.equal(validateReceipt("string").valid, false);
});

test("machine never emits an invalid receipt across the happy path", () => {
  const { receipt } = createReceipt({
    issue_id: "SHU-10",
    authorization_ref: "SHU-10",
    requested_worker: "codex-builder",
    repo: "BAWES-Universe/studenthub-platform",
    branch: "b",
    target_sha: SHA,
    attempt_id: "dddddddd-2222-4333-8444-555555555555",
  });
  const steps = [];
  let current = receipt;
  for (const [ev, label] of [
    [{ type: "launch" }, "LAUNCH_UNKNOWN"],
    [{ type: "worker_ack", external_run_id: "apirun_full", adapter_status: "queued" }, "RUNNING"],
    [{ type: "run_status", status: "in_progress" }, "RUNNING"],
    [{ type: "run_status", status: "completed", callback: { links: ["https://github.com/x/pull/9"], attempt_id: current.attempt_id, target_sha: SHA } }, "COMPLETED"],
  ]) {
    const r = nextReceiptState(current, ev);
    assert.equal(r.accepted, true, `step ${label}`);
    current = r.receipt;
    assert.equal(current.stage, label);
    assert.equal(validateReceipt(current).valid, true, `receipt at ${label} must validate: ${validateReceipt(current).errors?.join("; ")}`);
    steps.push(label);
  }
  assert.deepEqual(steps, ["LAUNCH_UNKNOWN", "RUNNING", "RUNNING", "COMPLETED"]);
});

test("receipt comments round-trip (durable receipt on the Linear thread)", () => {
  const { receipt } = createReceipt({
    issue_id: "SHU-11",
    authorization_ref: "SHU-11",
    requested_worker: "hermes-box",
    repo: "BAWES-Universe/studenthub-platform",
    branch: "b",
    target_sha: SHA,
    attempt_id: "eeeeeeee-2222-4333-8444-555555555555",
  });
  const body = receiptCommentBody(receipt);
  const parsed = parseReceiptCommentBody(body);
  assert.ok(parsed, "comment body must embed parseable receipt JSON");
  assert.deepEqual(parsed, receipt);
  assert.equal(parseReceiptCommentBody("no receipt here"), null);
});

test("all six stages are present and documented in STAGES", () => {
  assert.deepEqual([...STAGES].sort(), ["COMPLETED", "FAILED", "HOLD", "LAUNCH_UNKNOWN", "RESERVED", "RUNNING"].sort());
});
