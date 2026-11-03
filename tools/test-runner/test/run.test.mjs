import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildRunPlan, runDiscovered, runTests } from "../run.mjs";

const groups = ["runnerTests", "runnerMutationTests", "nodeTests", "mutationTests", "assertionTests",
  "deploymentTests", "documentTests", "exerciseTests", "dbTests", "dbNodeTests", "dbMutationTests", "dbDocumentTests"];
const empty = () => Object.fromEntries(groups.map((group) => [group, []]));
function inventory() {
  return {
    ...empty(),
    runnerTests: ["tools/test-runner/test/discover.test.mjs"],
    runnerMutationTests: ["tools/test-runner/test/discover-mutations.mjs"],
    nodeTests: ["dist/apps/example/test/plain.test.js", "dist/apps/gateway/test/web-ui.test.js",
      "dist/packages/observability/test/observability.test.js"],
    mutationTests: ["apps/example/test/mutations.mjs", "apps/gateway/test/context-navigation-mutations.mjs",
      "packages/private-documents/test/mutations.mjs", "packages/observability/test/mutations.mjs",
      "packages/private-documents/test/candidate-lifecycle-mutations.mjs"],
    assertionTests: ["packages/actor-assertion/test/actor-assertion.test.ts"],
    deploymentTests: ["deploy/coolify/test/deploy.test.mjs"],
    documentTests: ["packages/private-documents/test/plain.test.mjs",
      "packages/private-documents/test/candidate-lifecycle.test.mjs", "packages/private-documents/test/r2-lifecycle.test.mjs"],
    exerciseTests: ["tools/observability/synthetic-exercise.mjs"],
    dbTests: ["dist/packages/db/test/postgres-example.test.js"],
    dbNodeTests: ["packages/db/test/plain.test.mjs"],
    dbMutationTests: ["packages/db/test/example-mutations.mjs"],
    dbDocumentTests: ["packages/private-documents/test/r2-postgres.test.mjs"],
  };
}
const node = (...args) => ({ command: process.execPath, args });
const expected = (db) => db ? [
  node("--test", "--test-concurrency=1", "dist/packages/db/test/postgres-example.test.js"),
  node("--test", "packages/db/test/plain.test.mjs"),
  node("packages/db/test/example-mutations.mjs"),
  node("--test", "packages/private-documents/test/r2-postgres.test.mjs"),
] : [
  node("--test", "tools/test-runner/test/discover.test.mjs"),
  node("tools/test-runner/test/discover-mutations.mjs"),
  node("--test", "dist/apps/example/test/plain.test.js"),
  node("apps/example/test/mutations.mjs"),
  { command: "npx", args: ["--no-install", "vitest", "run", "packages/actor-assertion/test/actor-assertion.test.ts"] },
  node("--test", "deploy/coolify/test/deploy.test.mjs"),
  node("--test", "dist/apps/gateway/test/web-ui.test.js"),
  node("apps/gateway/test/context-navigation-mutations.mjs"),
  node("--test", "packages/private-documents/test/plain.test.mjs"),
  node("packages/private-documents/test/mutations.mjs"),
  node("--test", "dist/packages/observability/test/observability.test.js"),
  node("packages/observability/test/mutations.mjs"),
  node("tools/observability/synthetic-exercise.mjs"),
  node("--test", "packages/private-documents/test/candidate-lifecycle.test.mjs", "packages/private-documents/test/r2-lifecycle.test.mjs"),
  node("packages/private-documents/test/candidate-lifecycle-mutations.mjs"),
];
function spawner(outcome = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => outcome.error ? child.emit("error", outcome.error) :
      child.emit("exit", outcome.code ?? 0, outcome.signal ?? null));
    return child;
  };
  return { calls, spawnImpl };
}
const quiet = () => {};

test("SHU377_RUN_ORDER nonempty lanes retain exact commands, options, logs and order", async () => {
  for (const db of [false, true]) {
    const { calls, spawnImpl } = spawner();
    const logs = [];
    await runDiscovered(inventory(), {}, { root: "/fixture", db, spawnImpl, log: (line) => logs.push(line) });
    assert.deepEqual(calls, expected(db).map((entry) => ({ ...entry, options: { cwd: "/fixture", stdio: "inherit" } })));
    assert.deepEqual(logs, expected(db).map(({ command, args }) => `test-runner: ${command} ${args.join(" ")}`));
  }
});

test("SHU377_EMPTY_LANES each empty filtered lane never spawns a child", async () => {
  for (const db of [false, true]) {
    const full = expected(db);
    for (const removed of full) {
      const removedFiles = new Set(removed.args.filter((arg) => arg.includes("/")));
      const discovered = Object.fromEntries(Object.entries(inventory()).map(([group, files]) =>
        [group, files.filter((file) => !removedFiles.has(file))]));
      const { calls, spawnImpl } = spawner();
      await runDiscovered(discovered, {}, { db, spawnImpl, log: quiet });
      assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), full.filter((entry) => entry !== removed));
    }
    // No files in the selected mode is legal only when discovery itself is valid.
    const discovered = { ...empty(), [db ? "nodeTests" : "dbTests"]: ["other-mode.test.js"] };
    const { calls, spawnImpl } = spawner();
    await runDiscovered(discovered, {}, { db, spawnImpl, log: quiet });
    assert.equal(calls.length, 0);
    assert.deepEqual(buildRunPlan(discovered, { db }), []);
  }
});

test("SHU377_VALIDATION empty, duplicate and missing baseline discovery fail before spawning", async () => {
  for (const [discovered, baseline, reason] of [
    [empty(), {}, /discovery was empty/],
    [{ ...empty(), nodeTests: ["same"], dbTests: ["same"] }, {}, /multiple lanes/],
    [{ ...empty(), nodeTests: ["present"] }, { runnerTests: ["required"] }, /baseline tests missing/],
  ]) {
    for (const db of [false, true]) {
      const { calls, spawnImpl } = spawner();
      await assert.rejects(runDiscovered(discovered, baseline, { db, spawnImpl, log: quiet }), reason);
      assert.equal(calls.length, 0);
    }
  }
});

test("SHU377_FAILURES nonzero exit, spawn error and signal stop later lanes", async () => {
  for (const outcome of [{ code: 7 }, { signal: "SIGTERM" }, { error: new Error("spawn unavailable") }]) {
    const { calls, spawnImpl } = spawner(outcome);
    await assert.rejects(runDiscovered(inventory(), {}, { spawnImpl, log: quiet }),
      outcome.error ? /spawn unavailable/ : /exited with code (7|1)/);
    assert.equal(calls.length, 1);
  }
  await assert.rejects(runDiscovered(inventory(), {}, {
    spawnImpl: () => { throw new Error("synchronous spawn failure"); }, log: quiet,
  }), /synchronous spawn failure/);
});

async function fixture(t, files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "runner-execution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries({ "package.json": "{}", "dist/.keep": "",
    "tools/test-runner/baseline.json": "{}", ...files })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
  return root;
}

test("SHU377_INPUTS real discovery and baseline still run before spawning", async (t) => {
  const { calls, spawnImpl } = spawner();
  const root = await fixture(t);
  await assert.rejects(runTests({ root, spawnImpl, log: quiet }), /discovery was empty/);
  await writeFile(path.join(root, "package.json"), "not JSON");
  await assert.rejects(runTests({ root, spawnImpl, log: quiet }), /JSON/);
  const missing = await fixture(t, {
    "apps/example/test/present.test.mjs": "",
    "tools/test-runner/baseline.json": JSON.stringify({ runnerTests: ["required.test.mjs"] }),
  });
  await assert.rejects(runTests({ root: missing, spawnImpl, log: quiet }), /baseline tests missing/);
  assert.equal(calls.length, 0);
});

test("SHU377_ENTRY importing is inert and direct CLI preserves normal and database modes", async (t) => {
  const runner = new URL("../run.mjs", import.meta.url);
  const root = await fixture(t, {
    "apps/example/test/plain.test.mjs": 'console.log("NORMAL_MARKER");',
    "packages/db/test/plain.test.mjs": 'console.log("DATABASE_MARKER");',
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // Exercise a real CLI, not Node's nested-test mode.
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(runner.href)})`],
    { cwd: root, encoding: "utf8", env });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  for (const db of [false, true]) {
    const result = spawnSync(process.execPath, [runner.pathname, ...(db ? ["--db"] : [])], { cwd: root, encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, db ? /DATABASE_MARKER/ : /NORMAL_MARKER/);
    assert.doesNotMatch(result.stdout, db ? /NORMAL_MARKER/ : /DATABASE_MARKER/);
  }
});
