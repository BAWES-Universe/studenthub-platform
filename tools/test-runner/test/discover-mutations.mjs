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
