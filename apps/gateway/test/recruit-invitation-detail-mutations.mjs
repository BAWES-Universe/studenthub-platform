// Mutation checks execute sibling copies of the freshly built handler through
// the module swap hook. The compiled handler itself is never overwritten.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url);
const http = new URL("src/recruit/invitations-http.js", dist);
const suite = fileURLToPath(new URL("test/recruit-invitation-detail.test.js", dist));
const hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;
const cases = [
  ["serve another person's id", "INVDET_MINE", "INVDET_MINE all JSON misses are identical 404s", "candidate.id === wanted", "true"],
  ["offer an answer on a closed invitation", "INVDET_ACTIONS", "INVDET_ACTIONS closed invitation has no answer form", "const answer = v.canAnswer ?", "const answer = true ?"],
  ["render an unescaped company", "INVDET_SHOW", "INVDET_SHOW renders escaped detail: Sultan &lt;Co&gt; &amp; Sons", "${html(v.company)}", "${v.company}"],
  ["return an empty success for an unknown id", "INVDET_MINE", "INVDET_MINE all JSON misses are identical 404s", "if (!row)\n                return NOT_FOUND;", "if (!row) return { status: 200, body: { invitation: {} } };"],
];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function run(prefix, swaps) {
  const register = `import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--test", "--experimental-test-isolation=none", "--test-reporter=tap", `--test-name-pattern=^${escape(prefix)}`, suite], { encoding: "utf8", timeout: 60000 });
  assert.equal(result.error, undefined, `${prefix} runner must execute`);
  return { ...result, output: result.stdout + result.stderr };
}

for (const [name, prefix, message, needle, replacement] of cases) {
  const original = await readFile(http, "utf8");
  assert.equal(original.split(needle).length - 1, 1, `${name}: needle binds exactly once in ${fileURLToPath(http)}`);
  const mutant = new URL(http.href.replace(/\.js$/, `-mutant-${process.pid}.js`));
  try {
    const control = run(prefix, {});
    assert.equal(control.status, 0, `${name}: unmutated control passes\n${control.output}`);
    assert.match(control.output, new RegExp(`\\nok \\d+ - ${escape(prefix)}`), `${name}: control ran its named test`);
    await writeFile(mutant, original.replace(needle, replacement));
    const killed = run(prefix, { [http.href]: mutant.href });
    assert.notEqual(killed.status, 0, `${name}: mutant survived\n${killed.output}`);
    assert.match(killed.output, new RegExp(`\\nnot ok \\d+ - ${escape(prefix)}`), `${name}: named test fails`);
    assert.match(killed.output, /name: 'AssertionError'/, `${name}: dies by AssertionError\n${killed.output}`);
    assert.match(killed.output, new RegExp(`error: (?:'|\\|-\\n\\s+)${escape(message)}`), `${name}: dies on its own assertion message\n${killed.output}`);
    assert.doesNotMatch(killed.output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: mutant loads`);
    console.log(`KILLED ${name} -> ${message}`);
  } finally {
    await unlink(mutant).catch((error) => { if (error.code !== "ENOENT") throw error; });
    assert.equal(await readFile(http, "utf8"), original, `${name}: compiled handler remains byte-identical`);
  }
}
console.log(`${cases.length}/${cases.length} recruit invitation detail mutants killed`);
