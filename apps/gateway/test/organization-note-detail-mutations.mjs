import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../../../dist/apps/gateway/", import.meta.url);
const page = new URL("src/organizations/notes-page.js", dist);
const suite = fileURLToPath(new URL("test/organization-note-detail.test.js", dist));
const hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;
const cases = [
  ["serve the first note", "NOTEDET_MINE selects", "NOTEDET_MINE requested note is selected", page,
    "const note = notes.find((candidate) => candidate.noteId === noteId);", "const note = notes[0];"],
  ["drop detail text escaping", "NOTEDET_SHOW a staff", "NOTEDET_SHOW note text is escaped", page,
    '<p style="white-space: pre-wrap">${escapeHtml(note.text)}</p>', '<p style="white-space: pre-wrap">${note.text}</p>'],
  ["map thrown list to 404", "NOTEDET_UNAVAILABLE list", "NOTEDET_UNAVAILABLE detail is 503", page,
    "if (!ctx.response.headersSent)\n            return unavailable(ctx);", "if (!ctx.response.headersSent)\n            return error(ctx, 404);"],
  ["accept detail query", "NOTEDET_DENY preserves", "NOTEDET_DENY a query string is 400", page,
    "if (query.size !== 0)\n        return invalid(ctx);", "if (false)\n        return invalid(ctx);"],
];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function run(prefix, swaps) {
  const register = `import{register}from"node:module";register(${JSON.stringify(hook)},{data:${JSON.stringify(swaps)}});`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(register)}`, "--test", "--test-reporter=tap", `--test-name-pattern=^${escape(prefix)}`, suite], { encoding: "utf8", timeout: 60000 });
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
console.log(`${cases.length}/${cases.length} organization note detail mutants killed by their named assertions`);
