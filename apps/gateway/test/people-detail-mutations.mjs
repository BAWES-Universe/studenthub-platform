// People A-01: one person's page opens only for operator staff and admin, reads only a
// well-formed id, shows only the row asked for, and is linked from the People list.
// Mutants run on a copy.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = mkdtempSync(join(process.cwd(), ".people-detail-mutations-"));
try {
  cpSync("dist", join(root, "dist"), { recursive: true });
  cpSync("packages/db/dist", join(root, "packages/db/dist"), { recursive: true });
  const run = (pattern) => spawnSync(process.execPath,
    ["--test", "--experimental-test-isolation=none", "--test-reporter=tap", `--test-name-pattern=^${pattern}`, join(root, "dist/apps/gateway/test/people-detail.test.js")],
    { encoding: "utf8", timeout: 60_000 });
  const service = "dist/apps/gateway/src/people-directory.js";
  const route = "dist/apps/gateway/src/routes/profile.js";
  const ui = "dist/apps/gateway/src/web-ui.js";
  const mutants = [
    ["show a person to any signed-in caller", service, "if (!active || !PERSON_ID.test(principalId))", "if (!PERSON_ID.test(principalId))", "PERSON_ACCESS"],
    ["read any id shape", service, "if (!active || !PERSON_ID.test(principalId))", "if (!active)", "PERSON_ACCESS"],
    ["show whatever row the store returns", service, "person && person.principalId === principalId", "person", "PERSON_ACCESS"],
    ["accept a query on the page", route, "query.size === 0 && ", "", "PERSON_ACCESS"],
    ["leave the list unlinked", ui, '<th scope="row"><a href="${e(personHref(r.principalId))}">', '<th scope="row"><a>', "PERSON_LINKS"],
    ["link a view page that is not wired", ui, 'login.staffView ? `<a class="text-link"', 'true ? `<a class="text-link"', "PERSON_LINKS"],
    ["link messages that are not wired", ui, 'messages ? `<a class="text-link" href="${e(`${base}/message`)}">', 'true ? `<a class="text-link" href="${e(`${base}/message`)}">', "PERSON_LINKS"],
  ];
  for (const pattern of new Set(mutants.map((mutant) => mutant[4]))) assert.equal(run(pattern).status, 0, `baseline ${pattern}`);
  for (const [name, relative, from, to, pattern] of mutants) {
    const file = join(root, relative);
    const original = readFileSync(file, "utf8");
    assert.equal(original.split(from).length - 1, 1, `${name}: unique compiled anchor`);
    writeFileSync(file, original.replace(from, to));
    const result = run(pattern);
    assert.equal(result.status, 1, `${name}: mutant survived\n${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.split("\n").some((line) => line.startsWith("not ok ") && line.includes(pattern)),
      `${name}: ${pattern} did not fail\n${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes("ERR_ASSERTION"), `${name}: failure was not an assertion\n${result.stdout}${result.stderr}`);
    writeFileSync(file, original);
    console.log(`KILLED: ${name}`);
  }
  console.log(`${mutants.length}/${mutants.length} people A-01 person page mutations killed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
