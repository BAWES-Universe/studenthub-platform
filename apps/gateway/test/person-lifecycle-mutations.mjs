// A-02 slice 1: staff warnings and tags open only for operator staff and admin, take
// same-origin forms only, check every field as legacy does (tag and reason required)
// and write as the session's own person. Mutants run on a copy.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = mkdtempSync(join(process.cwd(), ".person-lifecycle-mutations-"));
try {
  cpSync("dist", join(root, "dist"), { recursive: true });
  cpSync("packages/db/dist", join(root, "packages/db/dist"), { recursive: true });
  const run = (pattern) => spawnSync(process.execPath,
    ["--test", "--experimental-test-isolation=none", "--test-reporter=tap", `--test-name-pattern=^${pattern}`, join(root, "dist/apps/gateway/test/person-lifecycle.test.js")],
    { encoding: "utf8", timeout: 60_000 });
  const page = "dist/apps/gateway/src/person-lifecycle.js";
  const ui = "dist/apps/gateway/src/web-ui.js";
  const mutants = [
    ["skip the People gate for non-staff", page, "if (result.status !== 200)\n        return { kind: \"status\", status: result.status };", "if (result.status === 401)\n        return { kind: \"status\", status: result.status };", "A02_DENY"],
    ["write as the person instead of the session", page, "actorId: actor.personId", "actorId: person.principalId", "A02_WARN"],
    ["accept another origin", page, "ctx.request.headers.origin === origin &&", "", "A02_ORIGIN"],
    ["accept a cross-site form", page, " && ctx.request.headers[\"sec-fetch-site\"] !== \"cross-site\"", "", "A02_ORIGIN"],
    ["accept any query on the page", page, "const queryOk = url.search === \"\" ||", "const queryOk = true ||", "A02_DENY"],
    ["pass a bad id to the store", page, "!UUID.test(itemId)", "false", "A02_DENY"],
    ["add a tag without a reason", page, "if (!tag || !reason)", "if (!tag)", "A02_TAGS"],
    ["keep surrounding spaces", page, "const t = value?.trim();", "const t = value;", "A02_WARN"],
    ["drop the length limits", page, "[...t].length <= max", "true", "A02_WARN"],
    ["take any number as the version", page, "/^[1-9]\\d{0,8}$/.test(body.version ?? \"\")", "/^-?\\d+(\\.\\d+)?$/.test(body.version ?? \"\")", "A02_CORRECT"],
    ["report a stale correction as not found", page, "result.kind === \"stale\" ?", "false ?", "A02_CORRECT"],
    ["report a duplicate tag as not found", page, "result.kind === \"duplicate\" ?", "false ?", "A02_TAGS"],
    ["remove a tag from a form with fields", page, "if (!body)\n            return refuse(ctx, service, g, 400, \"Fill in every field.\");", "", "A02_TAGS"],
    ["show the warning message unescaped", page, "warning-message\">${esc(w.message)}", "warning-message\">${w.message}", "A02_PAGE"],
    ["leave the page unlinked from the person page", ui, "login.lifecycle !== undefined ?", "false ?", "A02_PAGE"],
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
  console.log(`${mutants.length}/${mutants.length} A-02 person lifecycle mutations killed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
