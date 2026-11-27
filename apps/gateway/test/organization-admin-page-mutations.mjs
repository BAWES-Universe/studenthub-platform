// Organizations A-06: the company admin page opens only for staff and admin of a
// real company, offers terms and deletion only to admin, relays exactly what was
// reviewed, and refuses like an unknown path. Mutants run on a copy.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = mkdtempSync(join(process.cwd(), ".org-admin-mutations-"));
try {
  cpSync("dist", join(root, "dist"), { recursive: true });
  cpSync("packages/db/dist", join(root, "packages/db/dist"), { recursive: true });
  const run = (pattern) => spawnSync(process.execPath,
    ["--test", "--experimental-test-isolation=none", "--test-reporter=tap", `--test-name-pattern=^${pattern}`, join(root, "dist/apps/gateway/test/organization-admin-page.test.js")],
    { encoding: "utf8", timeout: 60_000 });
  const page = "dist/apps/gateway/src/organizations/admin-page.js";
  const ui = "dist/apps/gateway/src/web-ui.js";
  const mutants = [
    ["open the owner context too", page, 'const ROLES = ["admin", "staff"];', 'const ROLES = ["admin", "staff", "org-owner"];', "ADMIN_ACCESS"],
    ["refuse with a page other than the unknown path", page, "if (status === 404)", "if (false)", "ADMIN_ACCESS"],
    ["show staff the admin-only controls", page, 'role === "admin" || !FIELDS[field].adminOnly', "true", "ADMIN_PAGE"],
    ["link the page from an owner's workspace", ui, 'orgId && (role === "staff" || role === "admin")', "orgId", "ADMIN_PAGE"],
    ["leave the page unlinked from the company panel", ui, 'orgId && (role === "staff" || role === "admin")', "false", "ADMIN_NAVIGATION"],
    ["show a notice from a forged link", page, "if (query.size > 0)", "if (false)", "ADMIN_PAGE"],
    ["relay a staff preview of an admin-only field", page, "if (!mayChange(operator, field))\n        return refuse(ctx, 404);", "", "ADMIN_STAFF_LIMIT"],
    ["relay a staff confirm of an admin-only field", page, "if (!mayChange(operator, values.field))\n        return refuse(ctx, 404);", "", "ADMIN_STAFF_LIMIT"],
    ["send an empty box as empty", page, 'return value === "" && field !== "status"', 'return false && field !== "status"', "ADMIN_FLOW"],
    ["hide why a deletion is blocked", page, 'if (status === 409 && body?.error === "deletion_blocked"', 'if (false && body?.error === "deletion_blocked"', "ADMIN_DELETE"],
    ["return to a deleted company", page, 'field === "deletion" ? "/workspace" :', 'false ? "/workspace" :', "ADMIN_DELETE"],
    ["accept another origin", page, "ctx.request.headers.origin !== origin", "false", "ADMIN_GUARDS"],
    ["accept a repeated field", page, "if (!allowed.includes(key) || Object.hasOwn(out, key))", "if (!allowed.includes(key))", "ADMIN_GUARDS"],
    ["confirm for another company", page, "values.orgId !== orgId ||", "", "ADMIN_GUARDS"],
    ["leave forms enabled with no service", page, 'const off = !origin || !service(ctx, field) ? " disabled" : "";', 'const off = "";', "ADMIN_GUARDS"],
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
  console.log(`${mutants.length}/${mutants.length} organizations A-06 admin page mutations killed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
