import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url), page = new URL("src/organizations/candidates-page.js", dist), suite = fileURLToPath(new URL("test/organization-candidates-page.test.js", dist)), hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;
const cases = [
  ["show another person's placements", "ORGCAND_DETAIL", "only this person, latest first", "const shown = personId === undefined ? all : all.filter((a) => a.personId === personId);", "const shown = all;"],
  ["open a person never placed there", "ORGCAND_DENY", "owner /organization/org-a/candidates/dina", "if (personId !== undefined && shown.length === 0)\n            return error(ctx, 404);", "if (false)\n            return error(ctx, 404);"],
  ["drop the name escaping", "ORGCAND_LIST", "owner", "${esc(p.name)}</a></th>`", "${p.name}</a></th>`"],
  ["count an ended placement as working now", "ORGCAND_LIST", "owner", "const placedNow = (a, today) => a.startDate <= today && (a.endDate === null || a.endDate >= today);", "const placedNow = (a, today) => a.startDate <= today;"],
  ["list ended people first", "ORGCAND_LIST", "owner", "Number(b.now) - Number(a.now)", "Number(a.now) - Number(b.now)"],
  ["accept a query", "ORGCAND_DENY", "a query is refused", "if (requestUrl.searchParams.size !== 0)\n        return error(ctx, 400);", "if (false)\n        return error(ctx, 400);"],
  ["answer a failing read as not found", "ORGCAND_UNAVAILABLE", "/organization/org-a/candidates", "catch {\n        return unavailable(ctx);\n    }\n}", "catch {\n        return error(ctx, 404);\n    }\n}"],
];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function run(prefix, swaps) { const register = `import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`; const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--test", "--test-reporter=tap", `--test-name-pattern=^${escape(prefix)} `, suite], { encoding: "utf8", timeout: 60000 }); assert.equal(result.error, undefined, `${prefix} runner must execute`); return { ...result, output: result.stdout + result.stderr }; }
for (const [name, prefix, message, from, to] of cases) { const original = await readFile(page, "utf8"); assert.equal(original.split(from).length - 1, 1, `${name}: needle binds exactly once in ${fileURLToPath(page)}`); const target = new URL(page.href.replace(/\.js$/, `-mutant-${process.pid}.js`)); try { const control = run(prefix, {}); assert.equal(control.status, 0, `${name}: unmutated control passes\n${control.output}`); assert.match(control.output, new RegExp(`\\nok \\d+ - ${escape(prefix)} `), `${name}: control ran named test`); await writeFile(target, original.replace(from, to)); const mutant = run(prefix, { [page.href]: target.href }); assert.notEqual(mutant.status, 0, `${name}: mutant survived\n${mutant.output}`); assert.match(mutant.output, new RegExp(`\\nnot ok \\d+ - ${escape(prefix)} `), `${name}: named test fails`); assert.match(mutant.output, /name: 'AssertionError'/); assert.match(mutant.output, new RegExp(`error: (?:'|\\|-\\n\\s+)${escape(message)}`), `${name}: dies on own assertion`); assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/); } finally { await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; }); assert.equal(await readFile(page, "utf8"), original, `${name}: dist is byte-identical`); } console.log(`KILLED ${name}`); }
console.log(`${cases.length}/${cases.length} organization candidates page mutants killed`);
