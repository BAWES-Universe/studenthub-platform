import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sourceDir = new URL("../../../dist/packages/idempotency-contract/src/", import.meta.url);
const testFile = new URL("../../../dist/packages/idempotency-contract/test/idempotency-contract.test.js", import.meta.url);
const mutations = [
  {
    name: "remove the key payload check",
    file: "recording-store.js",
    from: "if (existing.fingerprint !== input.fingerprint)",
    to: "if (false)",
  },
  {
    name: "make the idempotency record non-unique",
    file: "recording-store.js",
    from: "options.enforceUniqueRecords ?? true",
    to: "options.enforceUniqueRecords ?? false",
  },
  {
    name: "stop normalizing the key casing",
    file: "idempotency.js",
    from: "const key = request.key.toLowerCase();",
    to: "const key = request.key;",
  },
];

for (const mutation of mutations) {
  const directory = await mkdtemp(join(tmpdir(), "shu-233-mutation-"));
  try {
    await cp(sourceDir, directory, { recursive: true });
    const target = join(directory, mutation.file);
    const original = await readFile(target, "utf8");
    assert.equal(original.split(mutation.from).length - 1, 1, `${mutation.name}: mutation binds exactly once`);
    await writeFile(target, original.replace(mutation.from, mutation.to));
    assert.notEqual(await readFile(target, "utf8"), original, `${mutation.name}: source changed`);

    const result = spawnSync(process.execPath, [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern=^SHU-233/parity-contract$",
      testFile.pathname,
    ], {
      encoding: "utf8",
      env: { ...process.env, SHU233_TEST_MODULE: pathToFileURL(join(directory, "index.js")).href },
      timeout: 30_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.error, undefined, `${mutation.name}: child process failed`);
    assert.notEqual(result.status, 0, `${mutation.name}: mutation survived`);
    assert.match(output, /not ok [0-9]+ - SHU-233\/parity-contract/, `${mutation.name}: named test did not fail\n${output}`);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/, `${mutation.name}: infrastructure failure`);
    process.stdout.write(`KILLED ${mutation.name} -> SHU-233/parity-contract\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

process.stdout.write(`${mutations.length}/${mutations.length} SHU-233 mutations killed\n`);
