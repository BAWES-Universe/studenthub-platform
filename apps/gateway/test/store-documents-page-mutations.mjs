// M-05: a store manager opens only the photo and CV of a person placed at their own
// store, through links that re-check sight, are bound to the viewer and version, are
// audited before they exist, and refuse like an unknown path. Mutants run on a copy.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = mkdtempSync(join(process.cwd(), ".store-documents-mutations-"));
try {
  cpSync("dist", join(root, "dist"), { recursive: true });
  cpSync("packages/db/dist", join(root, "packages/db/dist"), { recursive: true });
  const run = (pattern) => spawnSync(process.execPath,
    ["--test", "--experimental-test-isolation=none", "--test-reporter=tap", `--test-name-pattern=^${pattern}`, join(root, "dist/apps/gateway/test/store-documents-page.test.js")],
    { encoding: "utf8", timeout: 60_000 });
  const delivery = "dist/packages/private-documents/src/store-delivery.js";
  const page = "dist/apps/gateway/src/work/store-documents-page.js";
  const candidates = "dist/apps/gateway/src/work/store-candidates-page.js";
  const mutants = [
    ["skip the sight check", delivery, "if (!await this.options.sight.maySee(viewer, subject, storeId))", "if (false)", "STOREDOC_ACCESS"],
    ["let a person whose placement ended be seen", page, "(a.endDate === null || a.endDate >= today)));", "true));", "STOREDOC_ACCESS"],
    ["offer a civil ID image", delivery, "export const STORE_DOCUMENT_TYPES = ['personal-photo', 'resume'];", "export const STORE_DOCUMENT_TYPES = ['personal-photo', 'resume', 'civil-id-front'];", "STOREDOC_PAGE"],
    ["accept another viewer's link", delivery, "if (claim.viewer !== viewer)", "if (false)", "STOREDOC_OPEN"],
    ["issue a link when the audit fails", delivery, "catch {\n                return unavailable();\n            } // STOREDOC_MUTANT_AUDIT", "catch { /* swallowed */ } // STOREDOC_MUTANT_AUDIT", "STOREDOC_GUARDS"],
    ["refuse with a page other than the unknown path", page, "const notFound = (ctx) => { ctx.request.resume(); writeNotFound(ctx.request, ctx.response); return true; };", "const notFound = (ctx) => { ctx.request.resume(); ctx.writeHtml(ctx.response, 404, ctx.renderError(404, ctx.login)); return true; };", "STOREDOC_ACCESS"],
    ["accept another origin", page, "ctx.request.headers.origin !== origin ||", "", "STOREDOC_GUARDS"],
    ["accept a body on open", page, "done(bytes === 0)", "done(true)", "STOREDOC_GUARDS"],
    ["link the documents after the placement ended", candidates, "person.placements.some((a) => a.endDate === null || a.endDate >= today)", "true", "STOREDOC_PAGE"],
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
  console.log(`${mutants.length}/${mutants.length} M-05 store documents mutations killed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
