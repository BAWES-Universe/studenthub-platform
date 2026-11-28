// Each mutant is a sibling of the freshly built module imported by the real
// gateway test. The original dist file is never overwritten.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url);
const http = new URL("src/pay-contracts-http.js", dist);
const suite = fileURLToPath(new URL("test/organization-contracts-page.test.js", dist));
const hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;

// [mutant, named test, assertion message, needle in the compiled dist file, replacement]
const cases = [
  ["show candidateTotal in place of companyTotal", "ORGCON_COMPANY_TERMS full views", "ORGCON_COMPANY_TERMS candidate and transfer values stay hidden",
    'terms.payModel === "fixed_price" ? `${String(terms.companyTotal ?? "")} (${String(terms.completionPercentage ?? "")}% complete)`',
    'terms.payModel === "fixed_price" ? `${String(terms.candidateTotal ?? "")} (${String(terms.completionPercentage ?? "")}% complete)`'],
  ["drop escaping on a rendered value", "ORGCON_SHOW authorized readers", "ORGCON_SHOW rendered values are escaped",
    '${escapeHtml(String(contract.startDate ?? ""))}</td>', '${String(contract.startDate ?? "")}</td>'],
  ["answer a thrown listCompany as 404", "ORGCON_UNAVAILABLE unavailable", "ORGCON_UNAVAILABLE failures are 503",
    'if (pageMatch)\n                companyPageError(req, res, 503, "Contracts are unavailable right now.");',
    'if (pageMatch)\n                companyPageError(req, res, 404, "Contracts are unavailable right now.");'],
  ["accept a query string", "ORGCON_DENY refusals", "ORGCON_DENY query strings are 400",
    'if (url.search)\n                return companyPageError(req, res, 400, "The request is not valid.");',
    'if (false)\n                return companyPageError(req, res, 400, "The request is not valid.");'],
];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function run(prefix, swaps) {
  const register = `import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--test", "--test-reporter=tap", `--test-name-pattern=^${escape(prefix)}`, suite], { encoding: "utf8", timeout: 60000 });
  assert.equal(result.error, undefined, `${prefix} runner must execute`);
  return { ...result, output: result.stdout + result.stderr };
}

for (const [mutantName, prefix, message, from, to] of cases) {
  const original = await readFile(http, "utf8");
  assert.equal(original.split(from).length - 1, 1, `${mutantName}: the needle binds exactly once in ${fileURLToPath(http)}`);
  const mutant = new URL(http.href.replace(/\.js$/, `-mutant-${process.pid}.js`));
  try {
    const control = run(prefix, {});
    assert.equal(control.status, 0, `${mutantName}: the unmutated control passes\n${control.output}`);
    assert.match(control.output, new RegExp(`\\nok \\d+ - ${escape(prefix)}`), `${mutantName}: the control ran its named test`);
    await writeFile(mutant, original.replace(from, to));
    const result = run(prefix, { [http.href]: mutant.href });
    assert.notEqual(result.status, 0, `${mutantName}: the mutant survived\n${result.output}`);
    assert.match(result.output, new RegExp(`\\nnot ok \\d+ - ${escape(prefix)}`), `${mutantName}: its named test fails`);
    assert.match(result.output, /name: 'AssertionError'/, `${mutantName}: it dies by an AssertionError\n${result.output}`);
    assert.match(result.output, new RegExp(`error: (?:'|\\|-\\n\\s+)${escape(message)}`), `${mutantName}: it dies on its own assertion message\n${result.output}`);
    assert.doesNotMatch(result.output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutantName}: the mutant loads`);
    console.log(`KILLED ${mutantName} -> ${message}`);
  } finally {
    await unlink(mutant).catch((error) => { if (error.code !== "ENOENT") throw error; });
    assert.equal(await readFile(http, "utf8"), original, `${mutantName}: the dist file is byte-identical`);
  }
}
console.log(`${cases.length}/${cases.length} organization contracts page mutants killed`);
