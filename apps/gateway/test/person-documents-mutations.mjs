// A-03: one person's documents page opens only for operator staff and admin, lists
// without contents, opens a photo or CV only through the existing signed delivery,
// and keeps Civil ID photos review-only. Mutants run on a copy.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = mkdtempSync(join(process.cwd(), ".person-documents-mutations-"));
try {
  cpSync("dist", join(root, "dist"), { recursive: true });
  cpSync("packages/db/dist", join(root, "packages/db/dist"), { recursive: true });
  const run = (pattern) => spawnSync(process.execPath,
    ["--test", "--experimental-test-isolation=none", "--test-reporter=tap", `--test-name-pattern=^${pattern}`, join(root, "dist/apps/gateway/test/person-documents.test.js")],
    { encoding: "utf8", timeout: 60_000 });
  const service = "dist/apps/gateway/src/person-documents.js";
  const route = "dist/apps/gateway/src/routes/profile.js";
  const delivery = "dist/apps/gateway/src/civil-id-review-http.js";
  const ui = "dist/apps/gateway/src/web-ui.js";
  const mutants = [
    ["open a Civil ID photo from the person page", service, 'new Set(["personal-photo", "resume"])', 'new Set(["personal-photo", "resume", "civil-id-front"])', "DOCS_PAGE"],
    ["open without the person check", service, "if (result.status !== 200)\n        return result;\n    if (!PERSON_PAGE_OPENABLE", "if (!PERSON_PAGE_OPENABLE", "DOCS_ACCESS"],
    ["show a document twice as on file", service, "found.length === 1", "found.length >= 0", "DOCS_PAGE"],
    ["report a missing document as unavailable", service, "error.status === 403 ?", "false ?", "DOCS_OPEN"],
    ["accept a query on the list", route, 'principalId !== undefined && url.search === "" ?', "principalId !== undefined ?", "DOCS_ACCESS"],
    ["accept another origin", route, 'ctx.request.headers.origin !== origin ||', "", "DOCS_GUARDS"],
    ["accept a body on open", route, "return size === 0;", "return true;", "DOCS_GUARDS"],
    ["keep person page links review-only", delivery, "!(personPageLink(claim) ||", "!(false ||", "DOCS_OPEN"],
    ["deliver Civil ID photos on a person page link", delivery, '(claim.type === "personal-photo" || claim.type === "resume")', "true", "DOCS_OPEN"],
    ["leave the documents unlinked from the person page", ui, "login.civilIdReview?.staffDocuments ?", "false ?", "DOCS_PAGE"],
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
  console.log(`${mutants.length}/${mutants.length} A-03 person documents mutations killed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
