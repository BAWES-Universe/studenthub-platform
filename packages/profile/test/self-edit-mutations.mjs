import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const moduleFile = new URL("../../../dist/packages/profile/src/self-edit.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/profile/test/self-edit.test.js", import.meta.url));
const mutations = [
  ["SHU392_RULES", "normalized !== normalized.trim()", "false"],
  ["SHU392_RULES", "/\\s{2}/u.test(normalized)", "false"],
  ["SHU392_RULES", "!NAME.test(normalized)", "false"],
  ["SHU392_RULES", "!ARABIC_LETTER.test(normalized)", "false"],
  ["SHU392_RULES", "value.normalize(\"NFC\")", "value"],
  ["SHU372_WRITE", "return normalized ? safeWrite.preview(normalized)", "return false ? safeWrite.preview(normalized)"],
  ["SHU372_OWNER", "return normalized ? safeWrite.confirm(normalized)", "return false ? safeWrite.confirm(normalized)"],
];
const run = () => spawnSync(process.execPath, [suite], { encoding: "utf8" });
for (const [token, from, to] of mutations) {
  const original = await readFile(moduleFile, "utf8");
  assert.equal(original.split(from).length - 1, 1);
  try {
    await writeFile(moduleFile, original.replace(from, to));
    const result = run();
    assert.notEqual(result.status, 0, `${token} mutant survived: ${from}`);
    assert.match(result.stdout + result.stderr, new RegExp(`not ok \\d+ - ${token} `), JSON.stringify({ status: result.status, signal: result.signal, error: String(result.error), stdout: result.stdout, stderr: result.stderr }));
    assert.match(result.stdout + result.stderr, /ERR_ASSERTION/);
  } finally { await writeFile(moduleFile, original); }
}
