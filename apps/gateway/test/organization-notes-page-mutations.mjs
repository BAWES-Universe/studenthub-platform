// Mutation check for the company notes page. Each mutant is written as a
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
const page = new URL("src/organizations/notes-page.js", dist);
const suite = fileURLToPath(new URL("test/organization-notes-page.test.js", dist));
const hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;

// [item, test name prefix, the target assertion's message, compiled file, needle from dist, replacement]
const cases = [
  ["skip the Origin check", "NOTES_ORIGIN both posts", "NOTES_ORIGIN a missing Origin is 403", page,
    "ctx.request.headers.origin !== origin", "false"],
  ["redirect from confirm without calling organizationNotes.confirm", "NOTES_CONFIRM a confirmed note", "NOTES_CONFIRM confirm calls the service once", page,
    "const result = await ctx.login.organizationNotes.confirm(sessionCookie(ctx.request.headers.cookie), { orgId, field: values.field, value: values.value, token });",
    "const result = { status: 200, body: { receipt: {} } };"],
  ["map a 409 from confirm to 303", "NOTES_CONFIRM a confirmed note", "NOTES_CONFIRM a replay is 409", page,
    "if (result.status !== 200)\n        return failed(ctx, result.status);\n    ctx.response.writeHead(303,",
    "if (result.status !== 200 && result.status !== 409)\n        return failed(ctx, result.status);\n    ctx.response.writeHead(303,"],
  ["let a whitespace-only value through to the service", "NOTES_PREVIEW a typed note", "NOTES_PREVIEW a whitespace-only value never reaches the service", page,
    "values.value.trim().length === 0", "false"],
  ["drop the escape on the note text in the list", "NOTES_LIST staff and admin", "NOTES_LIST note text is escaped", page,
    "<p>${escapeHtml(note.text)}</p>", "<p>${note.text}</p>"],
  ["answer an empty 200 page when the service answers 404", "NOTES_DENY refusals", "NOTES_DENY every refusal is 404", page,
    "if (status === 401 || status === 404)\n        return error(ctx, status);",
    "if (status === 404)\n        return (ctx.writeHtml(ctx.response, 200, \"\"), true);\n    if (status === 401)\n        return error(ctx, status);"],
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
console.log(`${cases.length}/${cases.length} company notes page mutants killed by their named assertions`);
