import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// M-02 and M-05: each mutant of the store candidates page or of PlacementService.forManagedStore dies on its own named assertion.
const dist = new URL("../../../dist/", import.meta.url), page = new URL("apps/gateway/src/work/store-candidates-page.js", dist), service = new URL("packages/work/src/placement.js", dist);
const suite = fileURLToPath(new URL("apps/gateway/test/store-candidates-page.test.js", dist)), hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;
const LIST = "/workspace/stores/123e4567-e89b-42d3-a456-426614174001/candidates";
const cases = [
  [page, "let HEAD issue document links", "STOREDOC_HIDDEN", "STOREDOC_HIDDEN HEAD issues nothing", "(match[3] !== undefined || ctx.request.method !== \"HEAD\")", "(ctx.request.method !== \"HEAD\")"],
  [page, "open a person never placed there", "STORECAND_PERSON", `${LIST}/carl`, "if (personId !== undefined && shown.length === 0)\n            return error(ctx, 404);", "if (false)\n            return error(ctx, 404);"],
  [page, "drop the name escaping", "STORECAND_LIST", "STORECAND_LIST rows", "${esc(p.name)}</a></th>`", "${p.name}</a></th>`"],
  [page, "count an ended placement as working now", "STORECAND_LIST", "STORECAND_LIST rows", "const placedNow = (a, today) => a.startDate <= today && (a.endDate === null || a.endDate >= today);", "const placedNow = (a, today) => a.startDate <= today;"],
  [page, "list ended people first", "STORECAND_LIST", "STORECAND_LIST rows", "Number(b.now) - Number(a.now)", "Number(a.now) - Number(b.now)"],
  [page, "accept a query", "STORECAND_HIDDEN", "a query is refused", "if (requestUrl.searchParams.size !== 0)\n        return error(ctx, 400);", "if (false)\n        return error(ctx, 400);"],
  [page, "hide the placement cap", "STORECAND_LIMIT", "the capped list says so", "const capped = shown.length >= ASSIGNMENT_LIST_LIMIT;", "const capped = false;"],
  [page, "answer a failing read as not found", "STORECAND_QUIET", "a failing read is unavailable", "catch {\n        return unavailable(ctx);\n    }\n}", "catch {\n        return error(ctx, 404);\n    }\n}"],
  [page, "stop at a refused sight", "STOREDOC_LINKS", "STOREDOC_LINKS the page is served", "if (result.status !== 404)\n            throw", "if (true)\n            throw"],
  [page, "relay a link unescaped", "STOREDOC_LINKS", "STOREDOC_LINKS links are relayed escaped", 'href="${esc(l.url)}"', 'href="${l.url}"'],
  [page, "ask for links with no request", "STOREDOC_NONE", "a placement with no request asks for nothing", ".filter((id) => id !== null)", ".filter(() => true)"],
  [service, "open any store for any store manager", "STORECAND_HIDDEN", "STORECAND_HIDDEN otherManager", ".find((m) => m.storeId.toLowerCase() === id);", ".find(() => true);"],
  [service, "drop the store scope from the query", "STORECAND_LIST", "STORECAND_LIST rows", "listAssignments({ orgIds: [managed.orgId], storeId: id, ", "listAssignments({ orgIds: [managed.orgId], "],
];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function run(prefix, swaps) { const register = `import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`; const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--test", "--test-reporter=tap", `--test-name-pattern=^${escape(prefix)} `, suite], { encoding: "utf8", timeout: 60000 }); assert.equal(result.error, undefined, `${prefix} runner must execute`); return { ...result, output: result.stdout + result.stderr }; }
for (const [file, name, prefix, message, from, to] of cases) { const original = await readFile(file, "utf8"); assert.equal(original.split(from).length - 1, 1, `${name}: needle binds exactly once in ${fileURLToPath(file)}`); const target = new URL(file.href.replace(/\.js$/, `-mutant-${process.pid}.js`)); try { const control = run(prefix, {}); assert.equal(control.status, 0, `${name}: unmutated control passes\n${control.output}`); assert.match(control.output, new RegExp(`\\nok \\d+ - ${escape(prefix)} `), `${name}: control ran named test`); await writeFile(target, original.replace(from, to)); const mutant = run(prefix, { [file.href]: target.href }); assert.notEqual(mutant.status, 0, `${name}: mutant survived\n${mutant.output}`); assert.match(mutant.output, new RegExp(`\\nnot ok \\d+ - ${escape(prefix)} `), `${name}: named test fails`); assert.match(mutant.output, /name: 'AssertionError'/); assert.match(mutant.output, new RegExp(`error: (?:'|\\|-\\n\\s+)${escape(message)}`), `${name}: dies on own assertion\n${mutant.output}`); assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/); } finally { await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; }); assert.equal(await readFile(file, "utf8"), original, `${name}: dist is byte-identical`); } console.log(`KILLED ${name}`); }
console.log(`${cases.length}/${cases.length} store candidates page mutants killed`);
