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
