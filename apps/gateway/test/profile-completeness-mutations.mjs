import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const suite = fileURLToPath(new URL("../../../dist/apps/gateway/test/profile-completeness.test.js", import.meta.url));
const files = {
  gatherer: new URL("../../../dist/apps/gateway/src/profile-completeness.js", import.meta.url),
  route: new URL("../../../dist/apps/gateway/src/index.js", import.meta.url),
  renderer: new URL("../../../dist/apps/gateway/src/web-ui.js", import.meta.url),
};
const originals = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, url]) => [key, await readFile(url, "utf8")])));

function run(token) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=^${token} `, suite], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.error, undefined, `${token} runner must execute`);
  return { ...result, output: result.stdout + result.stderr };
}

async function kill({ file, token, needle, replacement, message }) {
  const url = files[file]; const original = originals[file];
  assert.equal(original.split(needle).length - 1, 1, `${token} needle binds exactly once`);
  const control = run(token);
  assert.equal(control.status, 0, `${token} passing control\n${control.output}`);
  try {
    await writeFile(url, original.replace(needle, replacement));
    const mutant = run(token);
    assert.notEqual(mutant.status, 0, `${token} mutant survived\n${mutant.output}`);
    assert.match(mutant.output, new RegExp(`not ok \\d+ - ${token}`));
    assert.match(mutant.output, /AssertionError/);
    assert.match(mutant.output, new RegExp(message));
    assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    console.log(`KILLED ${token} ${message}`);
  } finally {
    await writeFile(url, original);
    assert.equal(await readFile(url, "utf8"), original, `${token} original remains unchanged`);
  }
}

await kill({ file: "gatherer", token: "Q14_4_STATUS", needle: "        return failed;", replacement: "        throw new Error(\"mutant escaped source failure\");", message: "failure must preserve profile status" });
await kill({ file: "route", token: "Q14_4_NOWRITE", needle: "completeness = await gatherProfileCompleteness(authorizedPersonId, result.body, authorizedEmail, { login, profileRecords, documents: currentProfileAvatar() });", replacement: "await documents?.list(cookieValue(request.headers.cookie, \"__Host-studenthub_session\")); completeness = await gatherProfileCompleteness(authorizedPersonId, result.body, authorizedEmail, { login, profileRecords, documents: currentProfileAvatar() });", message: "whole page must make one documents list and no writes" });
await kill({ file: "gatherer", token: "Q14_4_NOWRITE", needle: "    return { result, profile: Object.freeze({ ...profile, fields: Object.freeze(fields) }), ...(choices.state === \"available\" ? { choices: choices.value } : {}) };", replacement: "    await dependencies.login.profileEdit?.preview(undefined).catch(() => undefined); return { result, profile: Object.freeze({ ...profile, fields: Object.freeze(fields) }), ...(choices.state === \"available\" ? { choices: choices.value } : {}) };", message: "whole page must make one documents list and no writes" });
await kill({ file: "gatherer", token: "Q14_4_COMPAT", needle: "profile: Object.freeze({ ...profile, fields: Object.freeze(fields) })", replacement: "profile", message: "derived result must replace the stored completeness field" });
await kill({ file: "renderer", token: "Q14_4_CHECKLIST", needle: "return \"/profile/documents\";", replacement: "return \"/profile/background\";", message: "Personal photo must carry its own target" });

for (const [key, url] of Object.entries(files)) assert.equal(await readFile(url, "utf8"), originals[key], `${key} original remains unchanged`);
