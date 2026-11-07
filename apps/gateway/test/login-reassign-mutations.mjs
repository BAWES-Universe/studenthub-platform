// SHU-496: executable gateway mutants; DB-only mutants are uniquely applied and
// reported for the CI Postgres suite named beside each one.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = mkdtempSync(join(process.cwd(), ".shu496-mutations-"));
try {
  cpSync("dist", join(root, "dist"), { recursive: true });
  cpSync("packages/db/dist", join(root, "packages/db/dist"), { recursive: true });
  const testFile = join(root, "dist/apps/gateway/test/login-reassign.test.js");
  const gatewayFile = join(root, "dist/apps/gateway/src/login-application.js");
  const dbFile = join(root, "packages/db/dist/postgres-login-store.js");
  const run = () => spawnSync(process.execPath,
    ["--test", "--experimental-test-isolation=none", "--test-reporter=tap", testFile],
    { encoding: "utf8", timeout: 30_000 });
  assert.equal(run().status, 0, "Q14-L mutation baseline");

  const gatewayMutants = [
    ["skip the bind call", "Q14L_BIND",
      "const binding = await dependencies.identities.bindStableId(config.issuer, claims.sub, stableUserId);",
      'const binding = "matched";'],
    ["treat mismatch as matched", "Q14L_REASSIGN",
      'if (binding === "mismatch" || binding === "locked")', 'if (binding === "locked")'],
    ["let a locked identity through", "Q14L_REASSIGN",
      'if (binding === "mismatch" || binding === "locked")', 'if (binding === "mismatch")'],
    ["call bind when no claim is present", "Q14L_CLAIMS",
      "if (stableUserId !== undefined && dependencies.identities.bindStableId) {",
      "if (dependencies.identities.bindStableId) {"],
  ];
  for (const [name, token, from, to] of gatewayMutants) {
    const original = readFileSync(gatewayFile, "utf8");
    assert.equal(original.split(from).length - 1, 1, `${name}: unique compiled anchor`);
    writeFileSync(gatewayFile, original.replace(from, to));
    const result = run();
    assert.equal(result.error, undefined, `${name}: mutant must execute`);
    assert.equal(result.signal, null, `${name}: mutant must exit normally`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stdout.split("\n").some((line) => line.startsWith("not ok ") && line.includes(token)),
      `${name}: ${token} did not fail\n${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes("ERR_ASSERTION"),
      `${name} (${token}): failure was not an assertion\n${result.stdout}${result.stderr}`);
    writeFileSync(gatewayFile, original);
    console.log(`KILLED: ${name}`);
  }

  const postgresMutants = [
    ["skip the session delete", "Q14L_REASSIGN",
      'await client.query("DELETE FROM login_sessions WHERE person_id = $1::text", [result.person_id]);', ""],
    ["skip the atomic compare", "Q14L_LOCK",
      `locked_at = CASE
                  WHEN current_identity.locked_at IS NULL
                   AND current_identity.stable_user_id IS NOT NULL
                   AND current_identity.stable_user_id <> $3::text
                  THEN clock_timestamp()`,
      `locked_at = CASE
                  WHEN false
                  THEN clock_timestamp()`],
  ];
  for (const [name, token, from, to] of postgresMutants) {
    const original = readFileSync(dbFile, "utf8");
    assert.equal(original.split(from).length - 1, 1, `${name}: unique compiled anchor`);
    writeFileSync(dbFile, original.replace(from, to));
    assert.notEqual(readFileSync(dbFile, "utf8"), original);
    writeFileSync(dbFile, original);
    console.log(`POSTGRES CI MUTANT PINNED: ${name} -> ${token}`);
  }
  assert.equal(run().status, 0, "restored mutation baseline");
} finally {
  rmSync(root, { recursive: true, force: true });
}
