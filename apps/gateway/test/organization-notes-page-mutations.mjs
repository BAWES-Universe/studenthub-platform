import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url);
const page = new URL("src/organizations/notes-page.js", dist);
const suite = fileURLToPath(new URL("test/organization-notes-page.test.js", dist));
const hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;
const cases = [
  ["skip the Origin check", "NOTES_ORIGIN rejects", "NOTES_ORIGIN a wrong Origin is 403", 'ctx.request.headers.origin !== origin', "false"],
  ["redirect without confirming", "NOTES_CONFIRM saves", "NOTES_CONFIRM calls confirm once", "const result = await ctx.login.organizationNotes.confirm(sessionCookie(ctx.request.headers.cookie), { orgId, field: values.field, value: values.value, token });", "const result = { status: 200, body: { receipt: {} } };"],
  ["map a conflict to success", "NOTES_CONFIRM saves", "NOTES_CONFIRM service conflict stays 409", "if (status === 409)", "if (false)"],
  ["accept whitespace", "NOTES_PREVIEW validates", "NOTES_PREVIEW whitespace never reaches the service", "values.value.trim().length === 0", "false"],
  ["render raw note text", "NOTES_LIST staff", "NOTES_LIST note text is escaped", "${escapeHtml(note.text)}", "${note.text}"],
  ["turn a hidden refusal into an empty page", "NOTES_DENY refusals", "NOTES_DENY service 404 stays 404", "if (status === 401 || status === 404)\n        return error(ctx, status);", "if (status === 404) return (ctx.writeHtml(ctx.response, 200, \"\"), true);\n    if (status === 401) return error(ctx, status);"],
];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function run(prefix, swaps) {
  const register = `import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--test", "--test-reporter=tap", `--test-name-pattern=^${escape(prefix)}`, suite], { encoding: "utf8", timeout: 60000 });
  assert.equal(result.error, undefined, `${prefix} runner must execute`);
  return { ...result, output: result.stdout + result.stderr };
}
for (const [name, prefix, message, from, to] of cases) {
  const original = await readFile(page, "utf8");
  assert.equal(original.split(from).length - 1, 1, `${name}: the needle binds exactly once`);
  const target = new URL(page.href.replace(/\.js$/, `-mutant-${process.pid}.js`));
  try {
    const control = run(prefix, {});
    assert.equal(control.status, 0, `${name}: the unmutated control passes\n${control.output}`);
    assert.match(control.output, new RegExp(`\\nok \\d+ - ${escape(prefix)}`), `${name}: the control ran its named test`);
    await writeFile(target, original.replace(from, to));
    const mutant = run(prefix, { [page.href]: target.href });
    assert.notEqual(mutant.status, 0, `${name}: the mutant survived\n${mutant.output}`);
    assert.match(mutant.output, new RegExp(`\\nnot ok \\d+ - ${escape(prefix)}`), `${name}: its named test fails`);
    assert.match(mutant.output, /name: 'AssertionError'/, `${name}: it dies by an assertion`);
    assert.match(mutant.output, new RegExp(`error: (?:'|\\|-\\n\\s+)${escape(message)}`), `${name}: it dies on its own assertion`);
    assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: the mutant loads`);
  } finally {
    await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
    assert.equal(await readFile(page, "utf8"), original, `${name}: dist remains byte-identical`);
  }
}
