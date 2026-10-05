import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The suite imports the root build of ../src, so the mutations target that build.
const recordsPath = new URL("../../../dist/packages/profile-records/src/records.js", import.meta.url);
const storePath = new URL("../../../dist/packages/profile-records/src/memory-store.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/profile-records/test/records.test.js", import.meta.url));
const files = new Map([[recordsPath, await readFile(recordsPath, "utf8")], [storePath, await readFile(storePath, "utf8")]]);
const mutations = [
  ["owner filter removed", storePath,
    "return row && row.ownerId === ownerId && row.kind === kind ? row : undefined;",
    "return row && row.kind === kind ? row : undefined;", "SHU144_CROSS_PERSON_NOT_FOUND"],
  ["soft delete replaced by a hard DELETE", storePath,
    "rows.set(current.id, record);",
    "if (record.status === \"deleted\") rows.delete(current.id); else rows.set(current.id, record);", "SHU144_RESTORE_AFTER_DELETE"],
  ["audit insert moved outside the transaction", storePath,
    "rows.set(record.id, record);",
    "rows.set(record.id, record); this.#rows.set(record.id, record);", "SHU144_AUDIT_ATOMIC"],
  ["deleted catalogue entries accepted", recordsPath,
    "if (resolved?.status !== \"active\")",
    "if (resolved === undefined)", "SHU144_DELETED_REFERENCE"],
];

try {
  for (const [name, path, from, to, assertionName] of mutations) {
    const original = files.get(path);
    assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
    await writeFile(path, original.replace(from, to));
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=^${assertionName} `, suite], { encoding: "utf8", timeout: 30_000 });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `${name}: mutation survived`);
    assert.match(output, new RegExp(`not ok \\d+ - ${assertionName} `), `${name}: named assertion did not fail\n${output}`);
    assert.match(output, /AssertionError/, `${name}: did not die by assertion\n${output}`);
    process.stdout.write(`KILLED ${name} -> ${assertionName}\n`);
    await writeFile(path, original);
  }
} finally {
  for (const [path, original] of files) await writeFile(path, original);
}
process.stdout.write(`${mutations.length}/${mutations.length} SHU-144 mutations killed\n`);
