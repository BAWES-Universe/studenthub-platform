// Run after build. Apply every mutant to a disposable dist tree so parallel
// tests never observe a half-written compiled module.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = mkdtempSync(join(process.cwd(), ".shu498-mutations-"));
try {
  cpSync("dist", join(root, "dist"), { recursive: true });
  const runtimeTest = join(root, "dist/apps/gateway/test/wiring-runtime.test.js");
  const contributionTest = join(root, "dist/apps/gateway/test/contributions.test.js");
  const run = (file) => spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 30_000 });
  for (const testFile of [runtimeTest, contributionTest]) {
    const baseline = run(testFile);
    assert.equal(baseline.error, undefined);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  }

  const mutants = [
    { name: "pay-contract services must remain spread into the application", file: "dist/apps/gateway/src/login-runtime.js", from: "...payContractArea.services,", to: "// mutant dropped pay-contract services", test: runtimeTest, token: "PREP_WIRING_SHAPE" },
    { name: "every wiring area must be closed", file: "dist/apps/gateway/src/login-runtime.js", from: "access.close(), profile.close(), organizationArea.close(), payContractArea.close(), ops.close()", to: "access.close(), organizationArea.close(), payContractArea.close(), ops.close()", test: runtimeTest, token: "PREP_WIRING_COUNT" },
    {
      name: "profile browser sessions must retain their independent pool", file: "dist/apps/gateway/src/wiring/profile.js",
      from: "const browserSessionPool = browserTokens ? new pg.Pool({ connectionString: databaseUrl }) : undefined;",
      // Falling back to login sessions models sharing the access area's pool.
      to: "const browserSessionPool = undefined;", test: runtimeTest, token: "PREP_WIRING_COUNT",
    },
    { name: "contributions must sort by order before key", file: "dist/apps/gateway/src/contributions/index.js", from: "left.order - right.order || left.key.localeCompare(right.key)", to: "left.key.localeCompare(right.key) || left.order - right.order", test: contributionTest, token: "PREP_NAV" },
    { name: "duplicate contribution keys must be refused", file: "dist/apps/gateway/src/contributions/index.js", from: "if (new Set(keys).size !== keys.length)\n        throw new Error(\"duplicate contribution key\");", to: "if (false)\n        throw new Error(\"duplicate contribution key\");", test: contributionTest, token: "PREP_NAV_MERGE" },
  ];

  for (const mutant of mutants) {
    const file = join(root, mutant.file);
    const original = readFileSync(file, "utf8");
    assert.equal(original.split(mutant.from).length - 1, 1, `${mutant.name}: unique anchor`);
    writeFileSync(file, original.replace(mutant.from, mutant.to));
    assert.notEqual(readFileSync(file, "utf8"), original, `${mutant.name}: applied`);
    const result = run(mutant.test);
    assert.equal(result.error, undefined, `${mutant.name}: executed`);
    assert.equal(result.signal, null, `${mutant.name}: exited normally`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stdout.split("\n").some(line => line.startsWith("not ok ") && line.includes(mutant.token)), `${mutant.name}: named assertion did not fail\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /ERR_ASSERTION/, `${mutant.name}: failure was not an assertion`);
    writeFileSync(file, original);
    console.log(`KILLED (applied + assertion verified): ${mutant.name}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
