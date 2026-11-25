// Access lane: sign-in records the issuer's email_verified answer, and only a
// boolean true counts as verified. Mutants run on a copy of the build.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = mkdtempSync(join(process.cwd(), ".email-verified-mutations-"));
try {
  cpSync("dist", join(root, "dist"), { recursive: true });
  cpSync("packages/db/dist", join(root, "packages/db/dist"), { recursive: true });
  const testFile = join(root, "dist/apps/gateway/test/login-application.test.js");
  const gatewayFile = join(root, "dist/apps/gateway/src/login-application.js");
  const run = () => spawnSync(process.execPath,
    ["--test", "--experimental-test-isolation=none", "--test-reporter=tap", "--test-name-pattern=^EMAIL_VERIFIED_", testFile],
    { encoding: "utf8", timeout: 60_000 });
  assert.equal(run().status, 0, "email verified mutation baseline");
  const mutants = [
    ["count any truthy claim as verified", "EMAIL_VERIFIED_RECORD", "claims.email_verified === true", "Boolean(claims.email_verified)"],
    ["record a blank address", "EMAIL_VERIFIED_RECORD", 'claims.email.trim() !== "" && ', ""],
    ["never record the answer", "EMAIL_VERIFIED_RECORD", "await dependencies.identities.recordEmailVerification(identity.personId, claims.email, claims.email_verified === true);", ""],
    ["let a failed write reject the sign-in", "EMAIL_VERIFIED_BEST_EFFORT",
      'console.warn(JSON.stringify({ event: "email_verification_not_recorded" }));', "throw new Error(\"not recorded\");"],
    ["sign in although the stale answer could not be forgotten", "EMAIL_VERIFIED_BEST_EFFORT",
      "throw forgetError;", ""],
    ["keep the old answer when the write fails", "EMAIL_VERIFIED_BEST_EFFORT",
      "await dependencies.identities.forgetEmailVerification?.(identity.personId);", ""],
  ];
  const original = readFileSync(gatewayFile, "utf8");
  for (const [name, token, from, to] of mutants) {
    assert.equal(original.split(from).length - 1, 1, `${name}: unique compiled anchor`);
    writeFileSync(gatewayFile, original.replace(from, to));
    const result = run();
    assert.equal(result.error, undefined, `${name}: mutant must execute`);
    assert.equal(result.status, 1, `${name}: mutant survived\n${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.split("\n").some((line) => line.startsWith("not ok ") && line.includes(token)),
      `${name}: ${token} did not fail\n${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes("ERR_ASSERTION"), `${name}: failure was not an assertion\n${result.stdout}${result.stderr}`);
    writeFileSync(gatewayFile, original);
    console.log(`KILLED: ${name}`);
  }
  assert.equal(run().status, 0, "restored email verified mutation baseline");
} finally {
  rmSync(root, { recursive: true, force: true });
}
