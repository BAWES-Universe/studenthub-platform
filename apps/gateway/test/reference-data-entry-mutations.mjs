import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url);
const page = new URL("src/reference-data-page.js", dist);
const suite = fileURLToPath(new URL("test/reference-data-entry.test.js", dist));
const hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;
const cases = [
  ["drop the entry-name escape", "REFENTRY_SHOW staff", "REFENTRY_SHOW entry names are escaped", "const escapedName = escapeHtml(String(item.name));", "const escapedName = String(item.name);"],
  ["answer 200 for an unknown id", "REFENTRY_FIND reads", "REFENTRY_FIND unknown entries are 404", "if (!item)\n                return plain(ctx, 404);", "if (!item) { ctx.writeHtml(ctx.response, 200, \"\"); return true; }"],
  ["read before the staff check", "REFENTRY_DENY authenticates", "REFENTRY_DENY refused people never resolve an entry", "    let navigation;", "    await ctx.catalogue?.resolveHistorical(match[1], match[2]);\n    let navigation;"],
  ["answer a thrown entry read as 404", "REFENTRY_UNAVAILABLE dependency", "REFENTRY_UNAVAILABLE dependency failure is 503", "if (error instanceof CatalogueError && error.code === \"invalid_catalogue_id\")\n                return plain(ctx, 404);\n            return unavailable(ctx);", "if (error instanceof CatalogueError && error.code === \"invalid_catalogue_id\")\n                return plain(ctx, 404);\n            return plain(ctx, 404);"],
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
console.log(`${cases.length}/${cases.length} reference-data-entry mutants killed by their named assertions`);
