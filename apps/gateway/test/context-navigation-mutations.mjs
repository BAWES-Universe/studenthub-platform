// Run after build. Mutants live in a disposable copy, never in source or dist.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = mkdtempSync(join(process.cwd(), ".shu91-mutations-"));
try {
  // Keep the deployed relative-import layout (documents and observability)
  // instead of a gateway-only copy that fails before any assertion executes.
  cpSync("dist", join(root, "dist"), { recursive: true });
  const file = join(root, "dist/apps/gateway/src/context-navigation.js");
  const original = readFileSync(file, "utf8");
  const testFile = join(root, "dist/apps/gateway/test/context-navigation.test.js");
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
      from: "export function createContextNavigation(sessions, store, organizationReader, deletions) {",
      to: `export function createContextNavigation(sessions, store, organizationReader, deletions) {
        const readGrants = store.listGrantsForPrincipal.bind(store);
        const cached = new Map();
        store.listGrantsForPrincipal = (id) => {
          if (!cached.has(id)) cached.set(id, readGrants(id));
          return cached.get(id);
        };`,
    },
    {
      name: "deleted organization cannot be selected",
      pattern: "SHU328_NAV_ACTIVE",
      from: "if (deletions && await deletions.isDeleted(org.id)) {",
      to: "if (false && await deletions.isDeleted(org.id)) {",
    },
    {
      name: "deleted organizations must be removed from contexts",
      pattern: "SHU328_NAV_LIST",
      from: "if (deleted.has(contexts[index].orgId))",
      to: "if (false && deleted.has(contexts[index].orgId))",
    },
    {
      name: "top-level cards must request sub-companies",
      pattern: "SHU332_NAV_SUBS",
      from: `const children = await organizationReader.listSubOrganizations({
                        principalId: session.personId, orgId: active.orgId, role: active.role,
                    });`,
      to: 'const children = { kind: "not_found" };',
    },
    {
      name: "unavailable sub-companies must not look empty",
      pattern: "SHU332_NAV_SUBS_UNAVAILABLE",
      from: ': children.kind === "unavailable" ? { kind: "unavailable" } : undefined;',
      to: ': children.kind === "unavailable" ? { kind: "found", subOrganizations: [] } : undefined;',
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
  const historyFile = join(root, "dist/apps/gateway/src/web-ui.js");
  const historyOriginal = readFileSync(historyFile, "utf8");
  for (const [name, from, to] of [
    ["history snapshot must be concealed", "document.documentElement.hidden = true;", "document.documentElement.hidden = false;"],
    ["history restore must revalidate", "if (event.persisted) location.reload();", "if (event.persisted) document.documentElement.hidden = false;"],
    ["history guard must be wired", "/assets/workspace-history.js", "/assets/missing-history.js"],
  ]) {
    assert.equal(historyOriginal.split(from).length - 1, 1, `${name}: unique anchor`);
    writeFileSync(historyFile, historyOriginal.replace(from, to));
    assert.notEqual(readFileSync(historyFile, "utf8"), historyOriginal, "history mutation applied");
    const result = run();
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /not ok .*SHU91_HISTORY:/);
    assert.match(result.stdout, /ERR_ASSERTION/);
    console.log(`KILLED (applied + SHU91_HISTORY assertion verified): ${name}`);
    writeFileSync(historyFile, historyOriginal);
  }
  for (const [name, from, to] of [
    ["sub-company names must be escaped", "escapeHtml(child.registryName)", "child.registryName"],
  ]) {
    assert.equal(historyOriginal.split(from).length - 1, 1, `${name}: unique anchor`);
    writeFileSync(historyFile, historyOriginal.replace(from, to));
    assert.notEqual(readFileSync(historyFile, "utf8"), historyOriginal, "sub-company mutation applied");
    const result = run();
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /not ok .*SHU332_NAV_SUBS_HTML /);
    assert.match(result.stdout, /ERR_ASSERTION/);
    console.log(`KILLED (applied + SHU332_NAV_SUBS_HTML assertion verified): ${name}`);
    writeFileSync(historyFile, historyOriginal);
  }
  const restored = run();
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  console.log("CONTROL: all navigation tests pass before mutation and after restoration");
} finally {
  rmSync(root, { recursive: true, force: true });
}
