import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const cataloguePath = new URL("../dist/catalogue.js", import.meta.url);
const storePath = new URL("../dist/memory-store.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/reference-catalogue/test/catalogue.test.js", import.meta.url));
const files = new Map([[cataloguePath, await readFile(cataloguePath, "utf8")], [storePath, await readFile(storePath, "utf8")]]);
const mutations = [
  ["candidate submission skips pending state", cataloguePath, "...input, status: \"pending\", submittedAt: now", "...input, status: \"approved\", submittedAt: now", "SHU166_PENDING_NOT_LISTED"],
  ["soft deletion destroys historical record", storePath, "const next = Object.freeze({ ...current, status: \"deleted\", deletedAt: now, updatedAt: now });\n        this.#items.set(id, next);", "const next = Object.freeze({ ...current, status: \"deleted\", deletedAt: now, updatedAt: now });\n        this.#items.delete(id);", "SHU166_HISTORICAL_RESOLVE"],
  ["recruiter gains write authority", cataloguePath, "const WRITE_ROLES = new Set([\"staff\", \"admin\"]);", "const WRITE_ROLES = new Set([\"staff\", \"admin\", \"recruiter\"]);", "SHU166_RECRUITER_WRITE"],
  ["cursor comparison repeats the boundary row", storePath, "key > after.sortKey || (key === after.sortKey && row.id > after.id)", "key >= after.sortKey || (key === after.sortKey && row.id > after.id)", "SHU166_STABLE_PAGE"],
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
process.stdout.write(`${mutations.length}/${mutations.length} SHU-166 mutations killed\n`);
