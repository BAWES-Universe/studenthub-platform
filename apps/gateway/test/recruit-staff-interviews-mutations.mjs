import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url), page = new URL("src/recruit/interviews-http.js", dist), suite = fileURLToPath(new URL("test/recruit-staff-interviews.test.js", dist)), hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;
const cases = [
  ["accept another query", "RECSTAFFINT_DENY", "?x=1", "if (keys.some((key) => key !== \"page\") || keys.length > 1 || (raw !== null && !PAGE_NUMBER.test(raw)))", "if (raw !== null && !PAGE_NUMBER.test(raw))"],
  ["accept page zero", "RECSTAFFINT_DENY", "?page=0", "const PAGE_NUMBER = /^[1-9][0-9]{0,5}$/;", "const PAGE_NUMBER = /^[0-9]{1,6}$/;"],
  ["drop the rating", "RECSTAFFINT_LIST", "rows escaped, latest first", "${v.rating ? ` · ${v.rating}/5` : \"\"}` : \"\"}</td></tr>", "` : \"\"}</td></tr>"],
  ["drop the company name escaping", "RECSTAFFINT_LIST", "rows escaped, latest first", "${html(v.company)}</a></td>", "${v.company}</a></td>"],
  ["hide the earlier page", "RECSTAFFINT_LIST", "the first page links earlier interviews", "b.more ? `<a", "false ? `<a"],
  ["link page two back to itself", "RECSTAFFINT_PAGES", "page two links back to the first page", "${b.page === 2 ? \"\" : `?page=${b.page - 1}`}", "${`?page=${b.page}`}"],
  ["always read the first page", "RECSTAFFINT_PAGES", "page two lists the older interviews", "raw === null ? 1 : Number(raw)", "1"],
  ["answer no service as not found", "RECSTAFFINT_UNAVAILABLE", "no service is unavailable", "if (!s?.staff) {\n            wantsHtml ? errorPage(write, 503, back)", "if (!s?.staff) {\n            wantsHtml ? errorPage(write, 404, back)"],
];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function run(prefix, swaps) { const register = `import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`; const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--test", "--test-reporter=tap", `--test-name-pattern=^${escape(prefix)} `, suite], { encoding: "utf8", timeout: 60000 }); assert.equal(result.error, undefined, `${prefix} runner must execute`); return { ...result, output: result.stdout + result.stderr }; }
for (const [name, prefix, message, from, to] of cases) { const original = await readFile(page, "utf8"); assert.equal(original.split(from).length - 1, 1, `${name}: needle binds exactly once in ${fileURLToPath(page)}`); const target = new URL(page.href.replace(/\.js$/, `-mutant-${process.pid}.js`)); try { const control = run(prefix, {}); assert.equal(control.status, 0, `${name}: unmutated control passes\n${control.output}`); assert.match(control.output, new RegExp(`\\nok \\d+ - ${escape(prefix)} `), `${name}: control ran named test`); await writeFile(target, original.replace(from, to)); const mutant = run(prefix, { [page.href]: target.href }); assert.notEqual(mutant.status, 0, `${name}: mutant survived\n${mutant.output}`); assert.match(mutant.output, new RegExp(`\\nnot ok \\d+ - ${escape(prefix)} `), `${name}: named test fails`); assert.match(mutant.output, /name: 'AssertionError'/); assert.match(mutant.output, new RegExp(`error: (?:'|\\|-\\n\\s+)${escape(message)}`), `${name}: dies on own assertion`); assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/); } finally { await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; }); assert.equal(await readFile(page, "utf8"), original, `${name}: dist is byte-identical`); } console.log(`KILLED ${name}`); }
console.log(`${cases.length}/${cases.length} staff interviews page mutants killed`);
