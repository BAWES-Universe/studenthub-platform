// Mutation checks execute sibling copies of the freshly built page module via
// the same gateway import graph used by the HTTP acceptance tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url);
const page = new URL("src/organizations/stores-page.js", dist);
const suite = fileURLToPath(new URL("test/organization-stores-page.test.js", dist));
const hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;

// [name, test prefix, assertion message, exact compiled needle, replacement]
const cases = [
  ["render a service 404 as an empty list", "STORES_DENY", "STORES_DENY refused response is 404",
    "if (result.status !== 200)\n        return error(ctx, 404);", "if (result.status !== 200)\n        result = { status: 200, body: { stores: [] } };"],
  ["render a thrown list as No stores yet", "STORES_DEGRADE", "STORES_DEGRADE failure is 503",
    "result = await service.list(sessionCookie(ctx.request.headers.cookie), orgId);\n    }\n    catch {\n        return unavailable(ctx);\n    }", "result = await service.list(sessionCookie(ctx.request.headers.cookie), orgId);\n    }\n    catch {\n        result = { status: 200, body: { stores: [] } };\n    }"],
  ["drop the escape on the store name", "STORES_ESCAPE", "STORES_ESCAPE both unsafe values are escaped",
    "${escapeHtml(store.name)}", "${store.name}"],
  ["accept a query string", "STORES_QUERY", "STORES_QUERY query is 400",
    "if (requestUrl.searchParams.size !== 0)\n        return error(ctx, 400);", "if (false)\n        return error(ctx, 400);"],
];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function run(prefix, swaps) {
  const register = `import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--test", "--test-reporter=tap", `--test-name-pattern=^${escape(prefix)} `, suite], { encoding: "utf8", timeout: 60000 });
  assert.equal(result.error, undefined, `${prefix} runner must execute`);
  return { ...result, output: result.stdout + result.stderr };
}

for (const [name, prefix, message, from, to] of cases) {
  const original = await readFile(page, "utf8");
  assert.equal(original.split(from).length - 1, 1, `${name}: the needle binds exactly once in ${fileURLToPath(page)}`);
  const target = new URL(page.href.replace(/\.js$/, `-mutant-${process.pid}.js`));
  try {
    const control = run(prefix, {});
    assert.equal(control.status, 0, `${name}: the unmutated control passes\n${control.output}`);
    assert.match(control.output, new RegExp(`\\nok \\d+ - ${escape(prefix)} `), `${name}: the control ran its named test`);
    await writeFile(target, original.replace(from, to));
    const mutant = run(prefix, { [page.href]: target.href });
    assert.notEqual(mutant.status, 0, `${name}: the mutant survived\n${mutant.output}`);
    assert.match(mutant.output, new RegExp(`\\nnot ok \\d+ - ${escape(prefix)} `), `${name}: its named test fails`);
    assert.match(mutant.output, /name: 'AssertionError'/, `${name}: it dies by AssertionError\n${mutant.output}`);
    assert.match(mutant.output, new RegExp(`error: (?:'|\\|-\\n\\s+)${escape(message)}`), `${name}: it dies on its own assertion message\n${mutant.output}`);
    assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: the mutant loads`);
    console.log(`KILLED ${name} -> ${message}`);
  } finally {
    await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
    assert.equal(await readFile(page, "utf8"), original, `${name}: the compiled file is byte-identical`);
  }
}
console.log(`${cases.length}/${cases.length} organization stores page mutants killed`);
