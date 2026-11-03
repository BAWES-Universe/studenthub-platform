import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertBaseline, discover, discoverMigrations, formatRun } from "../discover.mjs";

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), "shu370-"));
  for (const file of ["package.json", "dist/.keep", ...files]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), file === "package.json" ? "{}" : "");
  }
  return root;
}

test("SHU370_SAME_SET baseline files cannot silently disappear", () => {
  assert.throws(() => assertBaseline({ nodeTests: ["kept.test.js"] }, {
    nodeTests: ["kept.test.js", "lost.test.js"],
  }), /lost\.test\.js/);
});

test("SHU370_CONVENTION new conventional tests are discovered", async () => {
  const root = await fixture([
    "dist/apps/example/test/compiled.test.js",
    "dist/packages/example/test/new-card.test.js",
    "dist/packages/db/test/postgres-new-card.test.js",
    "apps/example/test/app.test.mjs",
    "packages/example/test/package.test.mjs",
    "packages/example/test/mutations-extra.mjs",
    "packages/db/test/db-source.test.mjs",
    "packages/private-documents/test/new-card.test.mjs",
  ]);
  const found = await discover(root);
  assert.deepEqual(found.nodeTests, [
    "apps/example/test/app.test.mjs",
    "dist/apps/example/test/compiled.test.js",
    "dist/packages/example/test/new-card.test.js",
    "packages/example/test/package.test.mjs",
  ]);
  assert.deepEqual(found.mutationTests, ["packages/example/test/mutations-extra.mjs"]);
  assert.deepEqual(found.dbNodeTests, ["packages/db/test/db-source.test.mjs"]);
  assert.deepEqual(found.dbTests, ["dist/packages/db/test/postgres-new-card.test.js"]);
  assert.deepEqual(found.documentTests, ["packages/private-documents/test/new-card.test.mjs"]);
});

test("SHU370_FAILS_CLOSED missing dist, unreadable package metadata, and empty discovery are errors", async () => {
  const missingDist = await mkdtemp(path.join(tmpdir(), "shu370-missing-dist-"));
  await writeFile(path.join(missingDist, "package.json"), "{}");
  await assert.rejects(discover(missingDist), /ENOENT/);
  const badPackage = await fixture(["apps/example/test/example.test.mjs"]);
  await writeFile(path.join(badPackage, "package.json"), "not json");
  await assert.rejects(discover(badPackage), /JSON/);
  const empty = await fixture([]);
  await assert.rejects(discover(empty), /discovery was empty/);
});

test("SHU370_FAILS_CLOSED runner reports the exact command and discovered file list", () => {
  assert.equal(formatRun(process.execPath, ["--test", "dist/example.test.js"]),
    `test-runner: ${process.execPath} --test dist/example.test.js`);
});

test("SHU370_FAILS_CLOSED non-conventional and database tests do not leak lanes", async () => {
  const root = await fixture([
    "dist/packages/example/test/not-a-test.js",
    "dist/packages/db/test/postgres-example.test.js",
    "packages/db/test/example-mutations.mjs",
  ]);
  const found = await discover(root);
  assert.deepEqual(found.nodeTests, []);
  assert.deepEqual(found.mutationTests, []);
  assert.deepEqual(found.dbTests, ["dist/packages/db/test/postgres-example.test.js"]);
  assert.deepEqual(found.dbMutationTests, ["packages/db/test/example-mutations.mjs"]);
});

test("SHU370_MIGRATIONS migration inventory is derived from sorted SQL files", async () => {
  const root = await fixture([
    "packages/db/migrations/0002_second.sql",
    "packages/db/migrations/0001_first.sql",
    "packages/db/migrations/README.md",
  ]);
  assert.deepEqual(await discoverMigrations(root), ["0001_first", "0002_second"]);
});

test("SHU377_RUNNER_NAMES unsupported test-like files fail rather than disappear", async () => {
  const lookalikes = [
    "example.test.js", "example.test.cjs", "example.test.ts", "example.test.mts",
    "example.spec.mjs", "example.tests.mjs", "example-test.mjs", "test-example.mjs",
    "example_test.mjs", "example.TEST.mjs", "mutations.mjs", "mutations-extra.mjs",
    "example-mutations.js", "example-mutation.mjs", "nested/example.spec.ts",
  ];
  for (const name of lookalikes) {
    const file = `tools/test-runner/test/${name}`;
    const root = await fixture(["tools/test-runner/test/kept.test.mjs", file]);
    await assert.rejects(discover(root), (error) =>
      error.message.startsWith("unsupported runner test names:") && error.message.includes(file),
    `SHU377_RUNNER_NAMES must refuse ${name}`);
  }
});

test("SHU377_RUNNER_HELPERS genuine helpers are permitted without becoming tests", async () => {
  const root = await fixture([
    "tools/test-runner/test/example.test.mjs",
    "tools/test-runner/test/example-mutations.mjs",
    "tools/test-runner/test/helper.mjs",
    "tools/test-runner/test/fixtures.mjs",
    "tools/test-runner/test/nested/helper.mjs",
    "tools/test-runner/test/contest.mjs",
    "tools/test-runner/test/README.md",
  ]);
  const found = await discover(root);
  assert.deepEqual(found.runnerTests, ["tools/test-runner/test/example.test.mjs"]);
  assert.deepEqual(found.runnerMutationTests, ["tools/test-runner/test/example-mutations.mjs"]);
  assert.equal(Object.values(found).flat().length, 2);
});

test("SHU377_MUTATION_NAMED_TESTS normal tests are classified once and real mutation scripts remain", async () => {
  const normalTests = [
    ["apps/example/test/example-mutations.test.mjs", "nodeTests"],
    ["packages/example/test/example-mutations.test.mjs", "nodeTests"],
    ["packages/db/test/example-mutations.test.mjs", "dbNodeTests"],
    ["packages/private-documents/test/example-mutations.test.mjs", "documentTests"],
    ["tools/test-runner/test/example-mutations.test.mjs", "runnerTests"],
  ];
  const scripts = [
    ["apps/example/test/example-mutations.mjs", "mutationTests"],
    ["packages/example/test/mutations-extra.mjs", "mutationTests"],
    ["packages/db/test/example-mutations.mjs", "dbMutationTests"],
    ["packages/private-documents/test/example-mutations.mjs", "mutationTests"],
    ["tools/test-runner/test/example-mutations.mjs", "runnerMutationTests"],
  ];
  const root = await fixture([...normalTests, ...scripts].map(([file]) => file));
  let found;
  await assert.doesNotReject(async () => { found = await discover(root); },
    "SHU377_MUTATION_NAMED_TESTS discovery must not double-classify test files");
  const all = Object.values(found).flat();
  for (const [file, lane] of [...normalTests, ...scripts]) {
    assert.ok(found[lane].includes(file), `${file} must remain in ${lane}`);
    assert.equal(all.filter((entry) => entry === file).length, 1, `${file} occurs exactly once`);
  }
});
