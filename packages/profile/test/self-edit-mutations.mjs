import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const moduleFile = new URL("../../../dist/packages/profile/src/self-edit.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/profile/test/self-edit.test.js", import.meta.url));
const pageModuleFile = new URL("../../../dist/apps/gateway/src/profile-edit-http.js", import.meta.url);
const pageSuite = fileURLToPath(new URL("../../../dist/apps/gateway/test/profile-edit-http.test.js", import.meta.url));
const profileModuleFile = new URL("../../../dist/packages/profile/src/profile.js", import.meta.url);
const mutations = [
  ["SHU372_RULES", "normalized !== normalized.trim()", "false"],
  ["SHU372_RULES", "/\\s{2}/u.test(normalized)", "false"],
  ["SHU372_RULES", "!NAME.test(normalized)", "false"],
  ["SHU372_RULES", "!ARABIC_LETTER.test(normalized)", "false"],
  ["SHU372_RULES", "value.normalize(\"NFC\")", "value"],
  ["SHU372_WRITE", "return normalized ? safeWrite.preview(normalized)", "return false ? safeWrite.preview(normalized)"],
  ["SHU372_OWNER", "return normalized ? safeWrite.confirm(normalized)", "return false ? safeWrite.confirm(normalized)"],
  ["SHU372_PAGE", "response.writeHead(303, { location: \"/profile\", \"cache-control\": \"no-store\" });", "response.writeHead(200, { location: \"/profile\", \"cache-control\": \"no-store\" });", pageModuleFile, pageSuite],
  ["SHU373_WRITE", "[\"male\", \"female\", \"other\"].includes(normalized)", "false"],
  ["SHU373_AGE", "minimum.getUTCFullYear() - PERSON_PROFILE_MINIMUM_AGE", "minimum.getUTCFullYear()"],
  ["SHU373_CATALOGUE", "if (!choice)\n                        throw new TypeError(\"unknown profile choice\");", "if (false)\n                        throw new TypeError(\"unknown profile choice\");", profileModuleFile, suite],
  ["SHU373_PAGE", "not_looking: \"Not looking right now\"", "not_looking: \"not_looking\"", pageModuleFile, pageSuite],
];
for (const [token, from, to, selectedModule = moduleFile, selectedSuite = suite] of mutations) {
  const original = await readFile(selectedModule, "utf8");
  assert.equal(original.split(from).length - 1, 1);
  try {
    await writeFile(selectedModule, original.replace(from, to));
    const result = spawnSync(process.execPath, [selectedSuite], { encoding: "utf8" });
    assert.notEqual(result.status, 0, `${token} mutant survived: ${from}`);
    assert.match(result.stdout + result.stderr, new RegExp(`not ok \\d+ - ${token} `), JSON.stringify({ status: result.status, signal: result.signal, error: String(result.error), stdout: result.stdout, stderr: result.stderr }));
    assert.match(result.stdout + result.stderr, /ERR_ASSERTION/);
  } finally { await writeFile(selectedModule, original); }
}
