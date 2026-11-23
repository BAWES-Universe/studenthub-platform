// Mutation check for the company owner edit page. Each mutant is written as a
// sibling of the compiled module the running gateway imports, and the named
// test runs with helpers/swap-module.mjs loading that sibling in place of the
// original, so the server really executes the mutant. The unmutated control
// must pass first, and the mutant must fail on its target assertion's own
// message. The compiled files are never overwritten.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url);
const page = new URL("src/organizations/edit-page.js", dist);
const suite = fileURLToPath(new URL("test/organization-edit-page.test.js", dist));
const hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;

// [mutant, test name prefix, the target assertion's message, compiled file, needle from dist, replacement]
const cases = [
  ["skip the Origin check", "EDIT_ORIGIN both posts", "EDIT_ORIGIN a missing Origin is 403", page,
    'ctx.request.headers.origin !== origin || ctx.request.headers["sec-fetch-site"] === "cross-site"', "false"],
  ["open the caller's first held role instead of org-owner", "EDIT_OWNER only the org-owner", "EDIT_OWNER recruiter of org-a is hidden", page,
    'const role = "org-owner";',
    'const role = (await navigation.open(session, new URLSearchParams())).body.contexts?.find((item) => item.orgId === orgId)?.role ?? "org-owner";'],
  ["redirect from confirm without calling organizationProfile.confirm", "EDIT_CONFIRM a confirmed", "EDIT_CONFIRM confirm calls the service once", page,
    "await profile.confirm(", "await (async () => ({ status: 200, body: {} }))("],
  ["drop the escape on the new value in the preview", "EDIT_PREVIEW a change", "EDIT_PREVIEW new value is escaped", page,
    '<dd class="new-value">${escapeHtml(next)}</dd>', '<dd class="new-value">${next}</dd>'],
  ["map state_changed to 303 instead of 409", "EDIT_CONFIRM a confirmed", "EDIT_CONFIRM state_changed is 409", page,
    "if (confirmed.status !== 200)", 'if (confirmed.status !== 200 && !(confirmed.status === 409 && confirmed.body.error === "state_changed"))'],
];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function run(prefix, swaps) {
  const register = `import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--test", "--test-reporter=tap", `--test-name-pattern=^${escape(prefix)}`, suite],
    { encoding: "utf8", timeout: 60000 });
  assert.equal(result.error, undefined, `${prefix} runner must execute`);
  return { ...result, output: result.stdout + result.stderr };
}

for (const [item, prefix, message, source, from, to] of cases) {
  const original = await readFile(source, "utf8");
  assert.equal(original.split(from).length - 1, 1, `${item}: the needle binds exactly once in ${fileURLToPath(source)}`);
  const target = new URL(source.href.replace(/\.js$/, `-mutant-${process.pid}.js`));
  try {
    const control = run(prefix, {});
    assert.equal(control.status, 0, `${item}: the unmutated control passes\n${control.output}`);
    assert.match(control.output, new RegExp(`\\nok \\d+ - ${escape(prefix)}`), `${item}: the control ran its named test`);
    await writeFile(target, original.replace(from, to));
    const mutant = run(prefix, { [source.href]: target.href });
    assert.notEqual(mutant.status, 0, `${item}: the mutant survived\n${mutant.output}`);
    assert.match(mutant.output, new RegExp(`\\nnot ok \\d+ - ${escape(prefix)}`), `${item}: its named test fails`);
    assert.match(mutant.output, /name: 'AssertionError'/, `${item}: it dies by an assertion\n${mutant.output}`);
    assert.match(mutant.output, new RegExp(`error: (?:'|\\|-\\n\\s+)${escape(message)}`), `${item}: it dies on "${message}"\n${mutant.output}`);
    assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${item}: the mutant loads`);
    console.log(`KILLED ${item} -> ${message}`);
  } finally {
    await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
    assert.equal(await readFile(source, "utf8"), original, `${item}: the compiled file is unchanged`);
  }
}
console.log(`${cases.length}/${cases.length} company edit page mutants killed by their named assertions`);
