// Mutation checks execute sibling copies of the freshly built handler through
// swap-module. The compiled handler itself is never overwritten.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url);
const http = new URL("src/recruit/invitations-http.js", dist);
const suite = fileURLToPath(new URL("test/recruit-invitation-detail.test.js", dist));
const hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;
const cases = [
  ["serve another person's invitation", "INVDET_MINE absent", "INVDET_MINE unavailable id is 404", ".find((candidate) => candidate.id.toLowerCase() === wanted)", ".find(() => true)"],
  ["render actions for a closed invitation", "INVDET_ACTIONS detail", "INVDET_ACTIONS closed invitation has no answer forms", "const answer = v.canAnswer ?", "const answer = true ?"],
  ["drop company escaping", "INVDET_SHOW a held", "INVDET_SHOW company name is escaped", "${html(v.company)} · ${html(v.store)}", "${v.company} · ${html(v.store)}"],
  ["return success for an unknown id", "INVDET_MINE absent", "INVDET_MINE unavailable id is 404", "return row ? { status: 200, body: { invitation: invitationView(row) } } : NOT_FOUND;", "return row ? { status: 200, body: { invitation: invitationView(row) } } : { status: 200, body: { invitation: invitationView((await p.store.mine(id))[0]) } };"],
];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    assert.match(mutant.output, new RegExp(`error: (?:'|\\|-\\n\\s+)${escape(message)}`), `${name}: it dies on its target assertion\n${mutant.output}`);
    assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: the mutant loads`);
  } finally {
    await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
    assert.equal(await readFile(http, "utf8"), original, `${name}: the compiled file is unchanged`);
  }
}
console.log(`${cases.length}/${cases.length} recruit invitation detail mutants killed`);
