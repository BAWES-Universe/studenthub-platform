// Access lane G-03: the grant audit page is wired, names each grant's
// organization, says a paused person's next request gets nothing, and is
// linked from the person page. Mutants run on a copy.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = mkdtempSync(join(process.cwd(), ".grant-audit-mutations-"));
try {
  cpSync("dist", join(root, "dist"), { recursive: true });
  cpSync("packages/db/dist", join(root, "packages/db/dist"), { recursive: true });
  const run = (file, pattern) => spawnSync(process.execPath,
    ["--test", "--experimental-test-isolation=none", "--test-reporter=tap", `--test-name-pattern=^${pattern}`, join(root, `dist/apps/gateway/test/${file}`)],
    { encoding: "utf8", timeout: 60_000 });
  const page = "dist/apps/gateway/src/access/admin-access.js";
  const mutants = [
    ["leave the audit page unrouted", page, "|| auditMatch !== null", "", "access-admin.test.js", "G03_AUDIT_PAGE"],
    ["name grants by organization id", page, "${input.names.get(grant.orgId) ?? grant.orgId}", "${grant.orgId}", "access-admin.test.js", "G03_AUDIT_PAGE"],
    ["drop the link from the person page", page, "\">What their access does now →</a>", "\"></a>", "access-admin.test.js", "G03_AUDIT_PAGE"],
    ["leave out the pause", page, "const paused = input.pause\n", "const paused = false\n", "access-pause.test.js", "A6_PAGE staff pause"],
  ];
  for (const [, , , , file, pattern] of mutants) assert.equal(run(file, pattern).status, 0, `baseline ${pattern}`);
  for (const [name, relative, from, to, testFile, pattern] of mutants) {
    const file = join(root, relative);
    const original = readFileSync(file, "utf8");
    assert.equal(original.split(from).length - 1, 1, `${name}: unique compiled anchor`);
    writeFileSync(file, original.replace(from, to));
    const result = run(testFile, pattern);
    assert.equal(result.status, 1, `${name}: mutant survived\n${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.split("\n").some((line) => line.startsWith("not ok ") && line.includes(pattern)),
      `${name}: ${pattern} did not fail\n${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes("ERR_ASSERTION"), `${name}: failure was not an assertion\n${result.stdout}${result.stderr}`);
    writeFileSync(file, original);
    console.log(`KILLED: ${name}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
