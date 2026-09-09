// Run after build. Mutants live in a disposable copy, never in source or dist.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = mkdtempSync(join(process.cwd(), ".shu91-mutations-"));
try {
  cpSync("dist/apps/gateway", root, { recursive: true });
  const file = join(root, "src/context-navigation.js");
  const original = readFileSync(file, "utf8");
  const testFile = join(root, "test/context-navigation.test.js");
  function run() {
    return spawnSync(process.execPath, ["--test", "--test-reporter=tap", testFile], {
      encoding: "utf8", timeout: 30_000,
    });
  }
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  const mutants = [
    {
      name: "session ownership cannot be fabricated",
      pattern: "anonymous, expired, logged-out and unknown-principal",
      from: "const session = sessionId ? await sessions.get(sessionId) : undefined;",
      to: 'const session = { personId: "person-1" };',
    },
    {
      name: "URL selection cannot be silently discarded",
      pattern: "partial, duplicate and unknown selections",
      from: "const selected = selection.size > 0;",
      to: "const selected = false;",
    },
    {
      name: "grants must be read again after revocation",
      pattern: "revocation denies the very next bookmarked request",
      from: "export function createContextNavigation(sessions, store) {",
      to: `export function createContextNavigation(sessions, store) {
        const readGrants = store.listGrantsForPrincipal.bind(store);
        const cached = new Map();
        store.listGrantsForPrincipal = (id) => {
          if (!cached.has(id)) cached.set(id, readGrants(id));
          return cached.get(id);
        };`,
    },
  ];
  for (const mutant of mutants) {
    assert.equal(original.split(mutant.from).length - 1, 1, `${mutant.name}: unique anchor`);
    const marker = `// APPLIED: ${mutant.name}`;
    writeFileSync(file, original.replace(mutant.from, `${marker}\n${mutant.to}`));
    assert.ok(readFileSync(file, "utf8").includes(marker), "mutation verified on disk");
    const result = run();
    assert.equal(result.error, undefined, "the mutant must execute, not time out");
    assert.equal(result.signal, null, "the mutant must exit normally");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stdout.split("\n").some((line) => line.startsWith("not ok ") && line.includes(mutant.pattern)),
      `${mutant.name}: intended regression did not fail\n${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes("ERR_ASSERTION"), "failure must be an assertion, not an import error");
    console.log(`KILLED (applied + assertion verified): ${mutant.name}`);
    writeFileSync(file, original);
  }
  const restored = run();
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  console.log("CONTROL: all navigation tests pass before mutation and after restoration");
} finally {
  rmSync(root, { recursive: true, force: true });
}
