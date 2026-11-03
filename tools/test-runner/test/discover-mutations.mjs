import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const original = await readFile(new URL("../discover.mjs", import.meta.url), "utf8");

async function loadMutant(name, find, replacement) {
  assert.ok(original.includes(find), `${name}: mutation target must exist`);
  const root = await mkdtemp(path.join(tmpdir(), `shu370-${name}-`));
  const modulePath = path.join(root, "discover.mjs");
  await writeFile(modulePath, original.replace(find, replacement));
  return import(`${pathToFileURL(modulePath).href}?mutant=${name}`);
}

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), "shu370-mutant-fixture-"));
  for (const [file, contents] of Object.entries({ "package.json": "{}", "dist/.keep": "", ...files })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
  return root;
}

{
  const mutant = await loadMutant("drop-discovered-file",
    "const actual = new Set(discovered[group]);",
    "const actual = new Set(discovered[group].slice(1));");
  assert.throws(() => assert.doesNotThrow(
    () => mutant.assertBaseline({ nodeTests: ["pinned.test.js"] }, { nodeTests: ["pinned.test.js"] }),
  ), /Got unwanted exception/,
    "SHU370_SAME_SET kills a mutant that drops one discovered file",
  );
}

{
  const mutant = await loadMutant("db-file-in-test",
    "!file.startsWith(\"dist/packages/db/test/\") &&",
    "true &&");
  const root = await fixture({ "dist/packages/db/test/postgres-example.test.js": "" });
  await assert.rejects(async () => {
    const found = await mutant.discover(root);
    assert.deepEqual(found.nodeTests, []);
    assert.deepEqual(found.dbTests, ["dist/packages/db/test/postgres-example.test.js"]);
  }, /multiple lanes/,
    "SHU370_CONVENTION kills a mutant that puts a db file in the normal test lane");
}

{
  const mutant = await loadMutant("empty-discovery-passes",
    "if (files.length === 0) throw new Error(\"test discovery was empty\");",
    "if (false) throw new Error(\"test discovery was empty\");");
  const root = await fixture({});
  await assert.rejects(
    () => assert.rejects(mutant.discover(root), /discovery was empty/),
    /Missing expected rejection/,
    "SHU370_FAILS_CLOSED kills a mutant that turns empty discovery into a pass");
}

console.log("SHU370_CONVENTION db-lane mutant and SHU370_FAILS_CLOSED fail-closed mutants killed by assertions");

// The follow-up mutants run the actual suite in an isolated copy. Each control
// must pass, and each mutant must fail its named assertion (not module loading).
const { spawnSync } = await import("node:child_process");
const { rm } = await import("node:fs/promises");
const runOriginal = await readFile(new URL("../run.mjs", import.meta.url), "utf8");
const suites = Object.fromEntries(await Promise.all(["discover.test.mjs", "run.test.mjs"].map(async (name) =>
  [name, await readFile(new URL(name, import.meta.url), "utf8")])));
async function killByRealSuite(name, moduleName, find, replacement, suite, assertion) {
  const source = moduleName === "discover.mjs" ? original : runOriginal;
  assert.equal(source.split(find).length, 2, `${name}: exactly one mutation target`);
  const root = await mkdtemp(path.join(tmpdir(), `runner-real-mutant-${name}-`));
  try {
    await mkdir(path.join(root, "test"));
    await writeFile(path.join(root, "discover.mjs"), original);
    await writeFile(path.join(root, "run.mjs"), runOriginal);
    await writeFile(path.join(root, "test", suite), suites[suite]);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const execute = () => spawnSync(process.execPath,
      ["--test", "--test-reporter=tap", `--test-name-pattern=${assertion}`, path.join(root, "test", suite)],
      { encoding: "utf8", env, timeout: 30_000 });
    const control = execute();
    assert.equal(control.error, undefined, `${name}: control launch`);
    assert.equal(control.status, 0, `${name}: control must pass\n${control.stdout}\n${control.stderr}`);
    assert.match(control.stdout, new RegExp(`ok \\d+ - ${assertion}`));
    await writeFile(path.join(root, moduleName), source.replace(find, replacement));
    const result = execute();
    assert.equal(result.error, undefined, `${name}: mutant launch`);
    assert.equal(result.signal, null, `${name}: mutant must terminate normally`);
    assert.notEqual(result.status, 0, `${name}: mutant must fail`);
    assert.match(result.stdout, new RegExp(`not ok \\d+ - ${assertion}`));
    assert.match(result.stdout, /code: 'ERR_ASSERTION'/, `${name}: assertion-bound failure`);
    assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    console.log(`${assertion}: ${name} killed by the real suite assertion`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
await killByRealSuite("ignore-runner-lookalikes", "discover.mjs",
  "if (unclassifiedRunnerTests.length > 0) {", "if (false) {",
  "discover.test.mjs", "SHU377_RUNNER_NAMES");
await killByRealSuite("double-classify-mutation-tests", "discover.mjs",
  '!file.endsWith(".test.mjs") && /\\/test\\/', '/\\/test\\/',
  "discover.test.mjs", "SHU377_MUTATION_NAMED_TESTS");
await killByRealSuite("empty-node-lane", "run.mjs",
  "if (files.length === 0) return;", "if (false) return;",
  "run.test.mjs", "SHU377_EMPTY_LANES");
await killByRealSuite("empty-vitest-lane", "run.mjs",
  "if (discovered.assertionTests.length) add", "if (true) add",
  "run.test.mjs", "SHU377_EMPTY_LANES");
await killByRealSuite("ignore-child-failure", "run.mjs",
  'if (code !== 0) throw new Error', 'if (false) throw new Error',
  "run.test.mjs", "SHU377_FAILURES");

await killByRealSuite("unresolved-entry-path", "run.mjs",
  'realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)',
  'path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)',
  "run.test.mjs", "SHU377_ENTRY");
