// Access lane G-02: store manager access on the Access pages is routed only
// for those who may open them, offered only where the caller may change it,
// same-origin, and exact in its fields. Mutants run on a copy.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = mkdtempSync(join(process.cwd(), ".store-grants-mutations-"));
try {
  cpSync("dist", join(root, "dist"), { recursive: true });
  cpSync("packages/db/dist", join(root, "packages/db/dist"), { recursive: true });
  const run = (file, pattern) => spawnSync(process.execPath,
    ["--test", "--experimental-test-isolation=none", "--test-reporter=tap", `--test-name-pattern=^${pattern}`, join(root, `dist/apps/gateway/test/${file}`)],
    { encoding: "utf8", timeout: 60_000 });
  const page = "dist/apps/gateway/src/access/admin-access.js";
  const suite = "access-store-grants.test.js";
  const mutants = [
    ["leave the store routes unrouted", page, '|| ((path === "/admin/access/store-preview"', '|| (false && (path === "/admin/access/store-preview"', suite, "G02_STORE_CONFIRM"],
    ["offer every store", page, "return org !== undefined && mayManageStoreAccess(callerGrants, org.orgId, org.ancestors);", "return true;", suite, "G02_STORE_PAGE"],
    ["offer changes on your own page", page, ': model.isSelf ? "" : `${search}${found}`', ": `${search}${found}`", suite, "G02_STORE_PAGE"],
    ["accept a cross-origin post", page, 'req.resume();\n        write(403, "Access", renderStoreGrantRefusal("invalid_request", "/admin/access"));\n        return true;', "", suite, "G02_STORE_CONFIRM"],
    ["accept extra fields", page, "if (!form || !request || Object.keys(form).some((key) => !allowed.has(key))) {", "if (!form || !request) {", suite, "G02_STORE_GUARDS"],
    ["say nothing changed after an unknown outcome", page, 'preview ? renderStoreGrantRefusal("unavailable", back) : renderUnconfirmed(back)', 'renderStoreGrantRefusal("unavailable", back)', suite, "G02_STORE_GUARDS"],
    ["show a store event by its scope only", page, "event.storeName === undefined ? SCOPE_NAMES", "true ? SCOPE_NAMES", suite, "G02_STORE_PAGE"],
    ["promise more than this store", page, "This covers this store only. Their other access is not changed.", "", suite, "G02_STORE_CONFIRM"],
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
  console.log(`${mutants.length}/${mutants.length} access G-02 store page mutations killed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
