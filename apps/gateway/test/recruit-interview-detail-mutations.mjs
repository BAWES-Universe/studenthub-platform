// Mutation checks for candidate interview detail. Each mutant is a sibling of
// the freshly built module imported by the named test through swap-module.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url);
const http = new URL("src/recruit/interviews-http.js", dist);
const suite = fileURLToPath(new URL("test/recruit-interview-detail.test.js", dist));
const hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;

// [mutant, named test, its own assertion message, dist needle, replacement]
const cases = [
  ["serve an interview the person does not hold", "INTDET_MINE reveals", "INTDET_MINE JSON denials are byte-identical",
    ".find((candidate) => candidate.id.toLowerCase() === wanted);", ".find(() => true);"],
  ["render a cancel form", "INTDET_READONLY has", "INTDET_READONLY detail has no form, cancel or evaluate control",
    "</ol><p><a class=\"text-link\" href=\"/recruit/my-interviews\">", "</ol><form method=\"post\" action=\"/cancel\"></form><p><a class=\"text-link\" href=\"/recruit/my-interviews\">"],
  ["drop company-name escaping", "INTDET_SHOW renders", "INTDET_SHOW renders Sultan &lt;Co&gt;",
    "${html(v.company)} · ${html(v.store)}", "${v.company} · ${html(v.store)}"],
  ["answer 200 empty for an unknown id", "INTDET_MINE reveals", "INTDET_MINE JSON denials are byte-identical",
    "return row ? { status: 200, body: { interview: personInterviewView(row) } } : NOT_FOUND;", "return row ? { status: 200, body: { interview: personInterviewView(row) } } : { status: 200, body: {} };"],
];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Node's TAP reporter JSON-safes a less-than sign as `\u003c` on some
// releases. Accept that serialization while still binding the failure to the
// target assertion's complete, exact message.
const tapMessage = (text) => escape(text).replaceAll("<", "(?:<|\\\\u003[cC])");
function run(prefix, swaps) {
  const register = `import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--test", "--test-reporter=tap", `--test-name-pattern=^${escape(prefix)}`, suite], { encoding: "utf8", timeout: 60000 });
  assert.equal(result.error, undefined, `${prefix} runner must execute`);
  return { ...result, output: result.stdout + result.stderr };
}

for (const [name, prefix, message, from, to] of cases) {
  const original = await readFile(http, "utf8");
  assert.equal(original.split(from).length - 1, 1, `${name}: the needle binds exactly once in ${fileURLToPath(http)}`);
  const target = new URL(http.href.replace(/\.js$/, `-mutant-${process.pid}.js`));
  try {
    const control = run(prefix, {});
    assert.equal(control.status, 0, `${name}: the unmutated control passes\n${control.output}`);
    assert.match(control.output, new RegExp(`\\nok \\d+ - ${escape(prefix)}`), `${name}: the control ran its named test`);
    await writeFile(target, original.replace(from, to));
    const mutant = run(prefix, { [http.href]: target.href });
    assert.notEqual(mutant.status, 0, `${name}: the mutant survived\n${mutant.output}`);
    assert.match(mutant.output, new RegExp(`\\nnot ok \\d+ - ${escape(prefix)}`), `${name}: its named test fails`);
    assert.match(mutant.output, /name: 'AssertionError'/, `${name}: it dies by an assertion\n${mutant.output}`);
    assert.match(mutant.output, new RegExp(`error: (?:'|\\|-\\n\\s+)${tapMessage(message)}`), `${name}: it dies on "${message}"\n${mutant.output}`);
    assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: the mutant loads`);
    console.log(`KILLED ${name} -> ${message}`);
  } finally {
    await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
    assert.equal(await readFile(http, "utf8"), original, `${name}: the compiled file is unchanged`);
  }
}
console.log(`${cases.length}/${cases.length} recruit interview detail mutants killed by their named assertions`);
