// Access lane G-02: the review page's "what changes for them" is wired to the
// person's real grants and the change's real outcome. Mutants run on a copy.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = mkdtempSync(join(process.cwd(), ".grant-effect-mutations-"));
try {
  cpSync("dist", join(root, "dist"), { recursive: true });
  cpSync("packages/db/dist", join(root, "packages/db/dist"), { recursive: true });
  const testFile = join(root, "dist/apps/gateway/test/access-admin.test.js");
  const run = () => spawnSync(process.execPath,
    ["--test", "--experimental-test-isolation=none", "--test-reporter=tap", "--test-name-pattern=^G02_PREVIEW_EFFECT", testFile],
    { encoding: "utf8", timeout: 60_000 });
  assert.equal(run().status, 0, "grant effect mutation baseline");
  const page = "dist/apps/gateway/src/access/admin-access.js";
  const service = "dist/packages/access/src/grant-service.js";
  const mutants = [
    ["ignore the roles the person already holds", service, "held: snapshot.targetGrants,", "held: [],"],
    ["treat a removal as keeping the scope", service, "after: decision.after },", "after: request.scope },"],
    ["leave the effect off the review page", page, "${input.effect ? renderGrantEffect(", "${false ? renderGrantEffect("],
    ["leave out what changes in the companies below", page, "${gained}${lost}${gainedBelow}${lostBelow}${belowNote}${none}", "${gained}${lost}${belowNote}${none}"],
  ];
  for (const [name, relative, from, to] of mutants) {
    const file = join(root, relative);
    const original = readFileSync(file, "utf8");
    assert.equal(original.split(from).length - 1, 1, `${name}: unique compiled anchor`);
    writeFileSync(file, original.replace(from, to));
    const result = run();
    assert.equal(result.status, 1, `${name}: mutant survived\n${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.split("\n").some((line) => line.startsWith("not ok ") && line.includes("G02_PREVIEW_EFFECT")),
      `${name}: G02_PREVIEW_EFFECT did not fail\n${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes("ERR_ASSERTION"), `${name}: failure was not an assertion\n${result.stdout}${result.stderr}`);
    writeFileSync(file, original);
    console.log(`KILLED: ${name}`);
  }
  assert.equal(run().status, 0, "restored grant effect mutation baseline");
} finally {
  rmSync(root, { recursive: true, force: true });
}
