// Mutation checks execute sibling copies of the freshly built handler through
// swap-module.mjs. The compiled handler itself is never changed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url);
const http = new URL("src/reports/certificates-http.js", dist);
const suite = fileURLToPath(new URL("test/certificate-detail.test.js", dist));
const hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;

// [mutant, named test, assertion message, needle in the compiled handler, replacement]
const cases = [
  ["serve a certificate the person does not hold", "CERTDET_MINE reveals only", "CERTDET_MINE other, unknown and malformed are 404",
    "const row = list.rows.find(candidate => candidate.assignmentId === ownDetail[1]);", "const row = list.rows[0];"],
  ["drop escaping on the company", "CERTDET_SHOW renders one", "CERTDET_SHOW company is escaped",
    "${esc(row.company)}</dd><dt>Store", "${row.company}</dd><dt>Store"],
  ["return an empty success for an unknown assignment", "CERTDET_MINE reveals only", "CERTDET_MINE other, unknown and malformed are 404",
    "if (!row)\n            return notFound(req, res);", "if (!row) { writeHtml(res, 200, pageDocument(\"Experience certificate\", \"<main></main>\")); return true; }"],
  ["read own certificates before the session check", "CERTDET_DENY applies the", "CERTDET_DENY own is not called without a permitted GET session",
    "if (!person)\n        return reply(req, res, 401, { status: \"unauthenticated\" }, \"Sign in\", \"Sign in to download your certificates.\", `<p><a href=\"/profile\">Go to your profile</a></p>`);",
    "if (!person) { await service.own(person); return reply(req, res, 401, { status: \"unauthenticated\" }, \"Sign in\", \"Sign in to download your certificates.\", `<p><a href=\"/profile\">Go to your profile</a></p>`); }"],
];

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function run(prefix, swaps) {
  const register = `import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--test", "--test-reporter=tap", `--test-name-pattern=^${escape(prefix)}`, suite], { encoding: "utf8", timeout: 60000 });
  assert.equal(result.error, undefined, `${prefix} runner must execute`);
  return { ...result, output: result.stdout + result.stderr };
}

for (const [mutantName, prefix, message, from, to] of cases) {
  const original = await readFile(http, "utf8");
  assert.equal(original.split(from).length - 1, 1, `${mutantName}: the needle binds exactly once in ${fileURLToPath(http)}`);
  const target = new URL(http.href.replace(/\.js$/, `-mutant-${process.pid}.js`));
  try {
    const control = run(prefix, {});
    assert.equal(control.status, 0, `${mutantName}: the unmutated control passes\n${control.output}`);
    assert.match(control.output, new RegExp(`\\nok \\d+ - ${escape(prefix)}`), `${mutantName}: the control ran its named test`);
    await writeFile(target, original.replace(from, to));
    const mutant = run(prefix, { [http.href]: target.href });
    assert.notEqual(mutant.status, 0, `${mutantName}: the mutant survived\n${mutant.output}`);
    assert.match(mutant.output, new RegExp(`\\nnot ok \\d+ - ${escape(prefix)}`), `${mutantName}: its named test fails`);
    assert.match(mutant.output, /name: 'AssertionError'/, `${mutantName}: it dies by an assertion\n${mutant.output}`);
    assert.match(mutant.output, new RegExp(`error: (?:'|\\|-\\n\\s+)${escape(message)}`), `${mutantName}: it dies on its own assertion message\n${mutant.output}`);
    assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutantName}: the mutant loads`);
    console.log(`KILLED ${mutantName} -> ${message}`);
  } finally {
    await unlink(target).catch(error => { if (error.code !== "ENOENT") throw error; });
    assert.equal(await readFile(http, "utf8"), original, `${mutantName}: the compiled file is unchanged`);
  }
}
console.log(`${cases.length}/${cases.length} certificate detail mutants killed by their named assertions`);
