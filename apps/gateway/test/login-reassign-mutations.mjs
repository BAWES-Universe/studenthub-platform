// SHU-496: gateway mutants execute locally; Postgres mutants are applied and
// structurally checked here, then killed by the CI-only database suite.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "node:test";

const root = mkdtempSync(join(process.cwd(), ".shu496-mutations-"));
try {
  const gatewayMutants = [
    ["Q14L_BIND skip the bind call",
      "stableUserId !== undefined && dependencies.identities.bindStableId",
      "false && dependencies.identities.bindStableId", "Q14L_BIND"],
    ["Q14L_REASSIGN treat mismatch as matched",
      'binding === "mismatch" || binding === "locked"',
      'binding === "locked"', "Q14L_REASSIGN"],
    ["Q14L_REASSIGN let a locked identity through",
      'binding === "mismatch" || binding === "locked"',
      'binding === "mismatch"', "Q14L_REASSIGN"],
    ["Q14L_CLAIMS call bind when no claim is present",
      "stableUserId !== undefined && dependencies.identities.bindStableId",
      "dependencies.identities.bindStableId", "Q14L_CLAIMS"],
  ];
  const testFiles = [];
  for (const [index, [name, from, to]] of gatewayMutants.entries()) {
    const variant = join(root, `variant-${index}`);
    cpSync("dist", join(variant, "dist"), { recursive: true });
    const appFile = join(variant, "dist/apps/gateway/src/login-application.js");
    const original = readFileSync(appFile, "utf8");
    assert.equal(original.split(from).length - 1, 1, `${name}: unique anchor`);
    writeFileSync(appFile, original.replace(from, to));
    testFiles.push(join(variant, "dist/apps/gateway/test/login-reassign.test.js"));
  }
  const failures = [];
  for await (const event of run({ files: testFiles, concurrency: false, isolation: "none" })) {
    if (event.type === "test:fail") failures.push(event.data);
  }
  const failureText = JSON.stringify(failures);
  assert.ok(failures.length >= gatewayMutants.length, failureText);
  for (const token of ["Q14L_BIND", "Q14L_REASSIGN", "Q14L_CLAIMS"]) {
    assert.ok(failureText.includes(token), `${token}: named test did not fail`);
  }
  assert.ok(failureText.includes("ERR_ASSERTION"), "mutants must die by assertion");
  for (const [name] of gatewayMutants) console.log(`KILLED: ${name}`);

  cpSync("dist", join(root, "db-dist"), { recursive: true });
  const dbFile = join(root, "db-dist/packages/db/src/postgres-login-store.js");
  const postgresMutants = [
    ["Q14L_REASSIGN skip the session delete",
      'await client.query("DELETE FROM login_sessions WHERE person_id = $1::text", [binding.person_id]);',
      "await Promise.resolve();"],
    ["Q14L_LOCK skip the atomic compare",
      "current.stable_user_id <> $3::text THEN clock_timestamp()",
      "false THEN clock_timestamp()"],
  ];
  for (const [name, from, to] of postgresMutants) {
    const original = readFileSync(dbFile, "utf8");
    assert.equal(original.split(from).length - 1, 1, `${name}: unique anchor`);
    writeFileSync(dbFile, original.replace(from, to));
    assert.notEqual(readFileSync(dbFile, "utf8"), original, `${name}: mutation applied`);
    console.log(`APPLIED AND CHECKED; CI Postgres named test kills: ${name}`);
    writeFileSync(dbFile, original);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
