import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { assertReviewerSandboxContract } from "../service/reviewer-isolation.mjs";

const source = fs.readFileSync(new URL("../reviewer-sandbox.sh", import.meta.url), "utf8");

// Execute the shipped functions and trap registrations verbatim. Only privileged
// tool boundaries are doubled; no root, host ACL, lock or systemd access occurs.
function runCleanup(text, primary, revoke, unlock, signal = "") {
  const start = text.indexOf("cleanup_step() {");
  const end = text.indexOf('/usr/bin/setfacl -m "u:${reviewer_uid}:r-x"', start);
  assert.ok(start >= 0 && end > start, "SHU261_CLEANUP_HARNESS: shipped cleanup and traps must be extracted");
  return spawnSync("/bin/bash", ["-p", "-c", `
set -euo pipefail
reviewer_uid=12345
canonical_workspace=/fixture/attempt
function /usr/bin/setfacl {
  printf 'revocation attempted: %s\\n' "$*"
  if (( ${revoke} )); then printf 'setfacl: fixture permission denied\\n' >&2; fi
  return ${revoke}
}
function /usr/bin/flock {
  printf 'lock release attempted: %s\\n' "$*"
  if (( ${unlock} )); then printf 'flock: fixture unlock denied\\n' >&2; fi
  return ${unlock}
}
${text.slice(start, end)}
${primary ? "printf 'PRIMARY: fixture reviewer failed\\n' >&2" : ":"}
${signal ? `kill -${signal} $$` : `exit ${primary}`}
`], { encoding: "utf8" });
}

function checkCleanup(run, primary, revoke, unlock) {
  assert.equal(run.status, primary || (revoke || unlock ? 1 : 0),
    "SHU261_CLEANUP_EXIT: preserve primary status; cleanup-only failure must fail closed");
  assert.match(run.stdout, /revocation attempted: -x u:12345 -- \/fixture\/attempt/,
    "SHU261_CLEANUP_REVOKE: execute the real revocation call with exact binding");
  assert.match(run.stdout, /lock release attempted: -u 9/,
    "SHU261_CLEANUP_ALL_STEPS: lock release must run even after revocation failure");
  assert.equal((run.stdout.match(/revocation attempted/g) ?? []).length, 1,
    "SHU261_CLEANUP_ONCE: signal and EXIT must not run cleanup twice");
  for (const [status, step, diagnostic] of [
    [revoke, "revoke reviewer workspace ACL", "setfacl: fixture permission denied"],
    [unlock, "release reviewer lock", "flock: fixture unlock denied"],
  ]) {
    if (status) {
      assert.ok(run.stderr.includes(`cleanup failed: ${step} (exit ${status})`),
        "SHU261_CLEANUP_REPORTED: every failed step and its status must be reported");
      assert.ok(run.stderr.includes(diagnostic), "SHU261_CLEANUP_STDERR: underlying tool stderr must survive");
    }
  }
  if (primary) {
    assert.match(run.stderr, /^PRIMARY: fixture reviewer failed\n/,
      "SHU261_CLEANUP_PRIMARY_CAUSE: original reason must precede cleanup diagnostics");
    if (revoke || unlock) assert.ok(run.stderr.includes(`primary failure retained (exit ${primary}); cleanup also failed`),
      "SHU261_CLEANUP_PRIMARY_RETAINED: explicitly retain the primary failure alongside cleanup failures");
  } else if (revoke || unlock) {
    assert.match(run.stderr, /cleanup failed after an otherwise successful run/,
      "SHU261_CLEANUP_ONLY_CAUSE: explain cleanup-only nonzero exit");
  } else {
    assert.equal(run.stderr, "", "SHU261_CLEANUP_SUCCESS: successful cleanup has no failure diagnostics");
  }
}

for (const primary of [0, 42]) for (const revoke of [0, 17]) for (const unlock of [0, 19]) {
  test(`SHU261 cleanup primary=${primary} revoke=${revoke} unlock=${unlock}`, () => {
    checkCleanup(runCleanup(source, primary, revoke, unlock), primary, revoke, unlock);
  });
}
for (const [signal, status] of [["HUP", 129], ["INT", 130], ["TERM", 143]]) {
  test(`SHU261 cleanup signal ${signal} preserves signal status and runs once`, () => {
    checkCleanup(runCleanup(source, status, 17, 19, signal), status, 17, 19);
  });
}

test("SHU261 shipped profile branches pass exact network properties to systemd-run", () => {
  const start = source.indexOf('if [[ "$profile" == "test" ]]; then');
  assert.ok(start >= 0, "SHU261_NETWORK_HARNESS: execute the shipped profile branches and launch argv");
  for (const profile of ["test", "model"]) {
    const run = spawnSync("/bin/bash", ["-p", "-c", `
set -euo pipefail
profile=${profile}
reviewer_uid=12345
reviewer_gid=12345
canonical_workspace=/fixture/attempt
systemd_args=()
CLAUDE_CODE_OAUTH_TOKEN=fixture-only
trusted_executable() { printf '%s\\n' "$1"; }
claude() { :; }
function /usr/bin/systemd-run { printf '%s\\n' "$@"; }
${profile === "test" ? 'set -- /fixture/node /srv/shu/studenthub-platform/.github/coordinator/review-execution-child.mjs' : 'set -- claude'}
${source.slice(start)}
`], { encoding: "utf8" });
    assert.equal(run.status, 0, "SHU261_NETWORK_BRANCH: shipped profile must reach the captured launch");
    assert.deepEqual(run.stdout.split("\n").filter((arg) => /PrivateNetwork|RestrictAddressFamilies/.test(arg)),
      profile === "test" ? ["--property=PrivateNetwork=yes", "--property=RestrictAddressFamilies=AF_UNIX"]
        : ["--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6"],
      "SHU261_NETWORK_ARGV: actual test networklessness and model address families must stay pinned");
  }
});

function mutated(from, to) {
  assert.equal(source.split(from).length, 2, "SHU261_MUTATION_ANCHOR: mutation must change exactly one anchor");
  return source.replace(from, to);
}
function dies(t, name, action) {
  assert.throws(action, (error) => {
    assert.equal(error.code, "ERR_ASSERTION", "SHU261_MUTATION_ASSERTION: mutation must die by an assertion");
    assert.ok(error.message.includes(name), `SHU261_MUTATION_NAMED: expected ${name}, got ${error.message}`);
    t.diagnostic(`Observed ERR_ASSERTION: ${error.message.split("\n")[0]}`);
    return true;
  });
}
const suppression = () => mutated('if "$@"; then', 'if "$@" || true; then');
test("SHU261 mutation suppressed revocation dies by cleanup-only exit assertion", (t) => {
  dies(t, "SHU261_CLEANUP_EXIT", () => checkCleanup(runCleanup(suppression(), 0, 17, 0), 0, 17, 0));
});
test("SHU261 mutation suppressed revocation dies by reporting assertion with primary failure", (t) => {
  dies(t, "SHU261_CLEANUP_REPORTED", () => checkCleanup(runCleanup(suppression(), 42, 17, 0), 42, 17, 0));
});
test("SHU261 model network claim pins exact families and absence of destination filtering", () => {
  assert.equal(assertReviewerSandboxContract(source), true);
  for (const file of ["../service/reviewer-isolation.mjs", "../service/SHU-261-VALIDATION.md", "../../../docs/SHU-63-activation-contract.md"]) {
    const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    // Construct the forbidden wording so this guard cannot match its own pattern.
    assert.ok(!text.includes(["provider", "network", "only"].join("-")) && !text.includes("ordinary provider"),
      "SHU261_NETWORK_DOC_CLAIM: current contract text must not imply provider destination confinement");
    assert.match(text, /no destination allowlist/, "SHU261_NETWORK_DOC_CLAIM: disclose no destination allowlist");
  }
});
for (const [name, from, to, assertion] of [
  ["provider overclaim", "address-family-restricted", ["provider", "network", "only"].join("-"), "SHU261_NETWORK_CLAIM"],
  ["widened model families", 'AF_UNIX AF_INET AF_INET6")', 'AF_UNIX AF_INET AF_INET6 AF_PACKET")', "SHU261_NETWORK_ENFORCEMENT"],
  ["destination filter added", "--property=ProtectSystem=strict", "--property=IPAddressAllow=192.0.2.1 \\\n  --property=ProtectSystem=strict", "SHU261_NETWORK_NO_ALLOWLIST"],
]) {
  test(`SHU261 mutation ${name} dies by ${assertion}`, (t) => {
    dies(t, assertion, () => assertReviewerSandboxContract(mutated(from, to)));
  });
}
