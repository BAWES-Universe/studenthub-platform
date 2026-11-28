import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url), page = new URL("src/organizations/interviews-page.js", dist), suite = fileURLToPath(new URL("test/organization-interviews-page.test.js", dist)), hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;
const cases = [
  ["accept a query", "ORGINT_DENY", "?x=1", "if (params.some((key) => key !== \"page\") || params.length > 1)\n        return error(ctx, 400);", "if (false)\n        return error(ctx, 400);"],
  ["accept page zero", "ORGINT_DENY", "?page=0", "const PAGE_NUMBER = /^[1-9][0-9]{0,5}$/;", "const PAGE_NUMBER = /^[0-9]{1,6}$/;"],
  ["answer a refusal as sign in", "ORGINT_DENY", "sibling /organization/org-a/interviews", "if (result.status !== 200)\n            return error(ctx, 404);", "if (result.status !== 200)\n            return error(ctx, 401);"],
  ["drop the company name escaping", "ORGINT_LIST", "escaped", "${esc(body.company)}'s", "${body.company}'s"],
  ["hide the earlier page", "ORGINT_LIST", "the first page links earlier interviews", "body.more ? `<a", "false ? `<a"],
  ["link page two back to itself", "ORGINT_PAGES", "page two links back to the first page", "${page === 2 ? \"\" : `?page=${page - 1}`}", "${`?page=${page}`}"],
  ["always read the first page", "ORGINT_PAGES", "page two lists the older interviews", "orgId, page);", "orgId, 1);"],
  ["answer a failing read as not found", "ORGINT_UNAVAILABLE", "a failing read is unavailable", "catch {\n        return unavailable(ctx);\n    }\n}", "catch {\n        return error(ctx, 404);\n    }\n}"],
];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function run(prefix, swaps) { const register = `import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`; const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--test", "--test-reporter=tap", `--test-name-pattern=^${escape(prefix)} `, suite], { encoding: "utf8", timeout: 60000 }); assert.equal(result.error, undefined, `${prefix} runner must execute`); return { ...result, output: result.stdout + result.stderr }; }
for (const [name, prefix, message, from, to] of cases) { const original = await readFile(page, "utf8"); assert.equal(original.split(from).length - 1, 1, `${name}: needle binds exactly once in ${fileURLToPath(page)}`); const target = new URL(page.href.replace(/\.js$/, `-mutant-${process.pid}.js`)); try { const control = run(prefix, {}); assert.equal(control.status, 0, `${name}: unmutated control passes\n${control.output}`); assert.match(control.output, new RegExp(`\\nok \\d+ - ${escape(prefix)} `), `${name}: control ran named test`); await writeFile(target, original.replace(from, to)); const mutant = run(prefix, { [page.href]: target.href }); assert.notEqual(mutant.status, 0, `${name}: mutant survived\n${mutant.output}`); assert.match(mutant.output, new RegExp(`\\nnot ok \\d+ - ${escape(prefix)} `), `${name}: named test fails`); assert.match(mutant.output, /name: 'AssertionError'/); assert.match(mutant.output, new RegExp(`error: (?:'|\\|-\\n\\s+)${escape(message)}`), `${name}: dies on own assertion`); assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/); } finally { await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; }); assert.equal(await readFile(page, "utf8"), original, `${name}: dist is byte-identical`); } console.log(`KILLED ${name}`); }
console.log(`${cases.length}/${cases.length} organization interviews page mutants killed`);
