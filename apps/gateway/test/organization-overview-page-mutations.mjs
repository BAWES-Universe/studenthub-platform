// Mutation checks execute sibling copies of the freshly built module; dist is never overwritten.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url);
const overview = new URL("src/organizations/overview-page.js", dist);
const suite = fileURLToPath(new URL("test/organization-overview-page.test.js", dist));
const hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;

// [mutant, named test, assertion message, needle in the compiled module, replacement]
const cases = [
  ["open as owner without a held-context check", "OVW_DENY every authenticated refusal", "OVW_DENY /organization/org-b?role=org-owner is hidden",
    "!heldAtOrganization", "false"],
  ["show Edit to every role", "OVW_LINKS actions", "OVW_LINKS staff has no Edit",
    'role === "org-owner" ? `<a href="${base}/edit">Edit company details</a>` : ""', '`<a href="${base}/edit">Edit company details</a>`'],
  ["allow onboarding as an organization id", "OVW_PASSTHROUGH reserved", "OVW_PASSTHROUGH /organization/onboarding bytes",
    '"onboarding", "create", "assigned-companies"', '"create", "assigned-companies"'],
  ["render an unescaped heading", "OVW_ESCAPE company names", "OVW_ESCAPE heading is escaped",
    '<h1>${escapeHtml(heading)}</h1>', '<h1>${heading}</h1>'],
  ["turn unavailable projection into 503", "OVW_DEGRADE unavailable", "OVW_DEGRADE unavailable is a notice",
    'if (result.body.organization.kind === "unavailable") {', 'if (result.body.organization.kind === "unavailable") return unavailable(ctx); if (false) {'],
];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function run(prefix, swaps) {
  const register = `import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--test", "--test-reporter=tap", `--test-name-pattern=^${escape(prefix)}`, suite], { encoding: "utf8", timeout: 60000 });
  assert.equal(result.error, undefined, `${prefix} runner must execute`);
  return { ...result, output: result.stdout + result.stderr };
}

for (const [name, prefix, message, from, to] of cases) {
  const original = await readFile(overview, "utf8");
  assert.equal(original.split(from).length - 1, 1, `${name}: the needle binds exactly once`);
  const target = new URL(overview.href.replace(/\.js$/, `-mutant-${process.pid}.js`));
  try {
    const control = run(prefix, {});
    assert.equal(control.status, 0, `${name}: the unmutated control passes\n${control.output}`);
    assert.match(control.output, new RegExp(`\\nok \\d+ - ${escape(prefix)}`), `${name}: the control ran its named test`);
    await writeFile(target, original.replace(from, to));
    const mutant = run(prefix, { [overview.href]: target.href });
    assert.notEqual(mutant.status, 0, `${name}: the mutant survived\n${mutant.output}`);
    assert.match(mutant.output, new RegExp(`\\nnot ok \\d+ - ${escape(prefix)}`), `${name}: its named test fails`);
    assert.match(mutant.output, /name: 'AssertionError'/, `${name}: it dies by AssertionError`);
    assert.match(mutant.output, new RegExp(`error: (?:'|\\|-\\n\\s+)${escape(message)}`), `${name}: it dies on its own assertion message`);
    assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: the mutant loads`);
  } finally {
    await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
    assert.equal(await readFile(overview, "utf8"), original, `${name}: dist remains byte-identical`);
  }
}
