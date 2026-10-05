// SHU-163: run after build. Mutants live in a disposable copy, never in source or dist.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = mkdtempSync(join(process.cwd(), ".shu163-mutations-"));
try {
  cpSync("dist", join(root, "dist"), { recursive: true });
  const testFile = join(root, "dist/apps/gateway/test/company-directory.test.js");
  const run = () => spawnSync(process.execPath, ["--test", "--test-reporter=tap", testFile], { encoding: "utf8", timeout: 30_000 });
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  const mutants = [
    ["company-directory.js", "unknown query parameters are refused", "SHU-163/AC-08 ACCESS",
      "if (!PARAMETERS.has(key) || query.getAll(key).length !== 1)", "if (query.getAll(key).length !== 1)"],
    ["company-directory.js", "session ownership cannot be fabricated", "SHU-163/AC-08 ACCESS",
      "const session = sessionId ? await sessions.get(sessionId) : undefined;", 'const session = { personId: "person-1" };'],
    ["company-directory.js", "the status filter reaches the directory", "SHU-163/AC-07 PAGE",
      "filters.status = status;", ""],
    ["web-ui.js", "employers get no company list link", "SHU-163/AC-07 PAGE",
      "if (!active || !login.companies || !DIRECTORY_ROLES.has(active.role))", "if (!active || !login.companies)"],
    ["web-ui.js", "company names are escaped", "SHU-163/AC-08 ACCESS",
      "${escapeHtml(name)}</a>${common}", "${name}</a>${common}"],
  ];
  for (const [module, name, pattern, from, to] of mutants) {
    const file = join(root, "dist/apps/gateway/src", module);
    const original = readFileSync(file, "utf8");
    assert.equal(original.split(from).length - 1, 1, `${name}: unique anchor`);
    writeFileSync(file, original.replace(from, to));
    assert.notEqual(readFileSync(file, "utf8"), original, "mutation applied");
    const result = run();
    assert.equal(result.error, undefined, "the mutant must execute, not time out");
    assert.equal(result.signal, null, "the mutant must exit normally");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stdout.split("\n").some((line) => line.startsWith("not ok ") && line.includes(pattern)),
      `${name}: intended regression did not fail\n${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes("ERR_ASSERTION"), "failure must be an assertion, not an import error");
    console.log(`KILLED (applied + assertion verified): ${name}`);
    writeFileSync(file, original);
  }
  const restored = run();
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  console.log(`${mutants.length}/${mutants.length} SHU-163 gateway mutations killed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
