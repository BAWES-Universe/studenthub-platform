// Mutation checks for certificate detail authorization, escaping, not-found, and session order.
// Each mutant is a sibling of the freshly built module imported by the running acceptance test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url);
const http = new URL("src/reports/certificates-http.js", dist);
const suite = fileURLToPath(new URL("test/certificate-detail.test.js", dist));
const hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;

// [mutant name, named test, its assertion message, needle in the compiled module, replacement]
const cases = [
  ["serve a certificate the person does not hold", "CERTDET_MINE refuses", "CERTDET_MINE another person's assignment is not served",
    "list.rows.find(r => r.assignmentId === detailId)", "list.rows.find(() => true)"],
  ["drop company escaping", "CERTDET_SHOW renders", "CERTDET_SHOW company text is escaped",
    "${esc(row.company)}", "${row.company}"],
  ["return an empty success for an unknown assignment", "CERTDET_MINE refuses", "CERTDET_MINE an unknown assignment is the same 404",
    "if (!row)\n            return notFound(req, res);", 'if (!row) { res.writeHead(200, { "content-type": "text/html" }); res.end(""); return true; }'],
  ["read own certificates before checking the session", "CERTDET_DENY checks", "CERTDET_DENY own is not called without a session",
    "if (!person)\n        return reply(req, res, 401,", "if (ownDetail) await service.own(person);\n    if (!person)\n        return reply(req, res, 401,"],
];

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function run(prefix, swaps) {
  const register = `import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--test", "--test-reporter=tap", `--test-name-pattern=^${escape(prefix)}`, suite],
    { encoding: "utf8", timeout: 60000 });
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
    assert.match(mutant.output, /name: 'AssertionError'/, `${name}: it dies by an AssertionError\n${mutant.output}`);
    assert.match(mutant.output, new RegExp(`error: (?:[\"']|\\|-\\r?\\n\\s+)${escape(message)}`), `${name}: it dies on its own assertion message\n${mutant.output}`);
    assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: the mutant loads`);
    console.log(`KILLED ${name} -> ${message}`);
  } finally {
    await unlink(target).catch(error => { if (error.code !== "ENOENT") throw error; });
    assert.equal(await readFile(http, "utf8"), original, `${name}: the compiled file is byte-identical`);
  }
}
console.log(`${cases.length}/${cases.length} certificate detail mutants killed by their named assertions`);
