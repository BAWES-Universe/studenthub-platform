import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url);
const page = new URL("src/reference-data-page.js", dist);
const suite = fileURLToPath(new URL("test/reference-data-page.test.js", dist));
const hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;
const cases = [
  ["accept staff at any organization", "REF_STAFF only", "REF_STAFF non-operator context is hidden", "&& DEFAULT_OPERATOR_ORG_IDS.includes(context.orgId)", "&& true"],
  ["drop the entry-name escape", "REF_LIST lists", "REF_LIST entry names are escaped", "escapeHtml(item.name)", "String(item.name)"],
  ["ignore the supplied cursor", "REF_LIST lists", "REF_LIST following the cursor does not repeat first-page entries", "cursor: cursors[0]", "cursor: undefined"],
  ["allow a second query key", "REF_QUERY rejects", "REF_QUERY a second query key is rejected", 'if (url.searchParams.size > 1 || [...url.searchParams.keys()].some((key) => key !== "cursor")', "if (false"],
  ["answer 200 without a catalogue", "REF_UNAVAILABLE missing", "REF_UNAVAILABLE dependency failure is 503", 'ctx.writeHtml(ctx.response, 503, ctx.pageDocument("Reference data unavailable"', 'ctx.writeHtml(ctx.response, 200, ctx.pageDocument("Reference data unavailable"'],
];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function run(prefix, swaps) {
  const register = `import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--test", "--test-reporter=tap", `--test-name-pattern=^${escape(prefix)}`, suite], { encoding: "utf8", timeout: 60000 });
  assert.equal(result.error, undefined, `${prefix} runner must execute`); return { ...result, output: result.stdout + result.stderr };
}
for (const [name, prefix, message, from, to] of cases) {
  const original = await readFile(page, "utf8"); assert.equal(original.split(from).length - 1, 1, `${name}: the needle binds exactly once in ${fileURLToPath(page)}`);
  const target = new URL(page.href.replace(/\.js$/, `-mutant-${process.pid}.js`));
  try {
    const control = run(prefix, {}); assert.equal(control.status, 0, `${name}: the unmutated control passes\n${control.output}`); assert.match(control.output, new RegExp(`\\nok \\d+ - ${escape(prefix)}`), `${name}: the control ran its named test`);
    await writeFile(target, original.replace(from, to)); const mutant = run(prefix, { [page.href]: target.href }); assert.notEqual(mutant.status, 0, `${name}: the mutant survived\n${mutant.output}`); assert.match(mutant.output, new RegExp(`\\nnot ok \\d+ - ${escape(prefix)}`), `${name}: its named test fails`); assert.match(mutant.output, /name: 'AssertionError'/, `${name}: it dies by an assertion\n${mutant.output}`); assert.match(mutant.output, new RegExp(`error: (?:'|\\|-\\n\\s+)${escape(message)}`), `${name}: it dies on its own assertion`); assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: the mutant loads`);
  } finally { await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; }); assert.equal(await readFile(page, "utf8"), original, `${name}: the compiled file is unchanged`); }
}
console.log(`${cases.length}/${cases.length} reference-data mutants killed by their named assertions`);
