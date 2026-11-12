// Mutation check for the civil ID suggestion line. Each mutant is written as a
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
const http = new URL("src/civil-id-suggestion-http.js", dist), gateway = new URL("src/index.js", dist), webUi = new URL("src/web-ui.js", dist);
const suite = fileURLToPath(new URL("test/civil-id-suggestion-http.test.js", dist));
const hook = new URL("./helpers/swap-module.mjs", import.meta.url).href;
const NUMBER = "123456781234";

// [item, test name prefix, the target assertion's message, compiled file, needle from dist, replacement]
const cases = [
  ["item 1 render the full number", "OCRP_LINE a read suggestion", "OCRP_LINE the full number never renders", http,
    'const hidden = `<input type="hidden" name="suggestionId"', `const hidden = \`<span hidden>${NUMBER}</span><input type="hidden" name="suggestionId"`],
  ["item 1 accept form for an expired date", "OCRP_LINE an expired date", "OCRP_LINE an expired date has no accept form", http,
    'Upload a current photo"}</a>${dismiss}', 'Upload a current photo"}</a><form method="post" action="/profile/civil-id/suggestion/accept"></form>${dismiss}'],
  ["item 2 save without CIV's service", "OCRP_ACCEPT accept saves", "OCRP_ACCEPT saves once through CIV", http,
    "await service.civilId.save(", "await (async () => ({ ok: true }))("],
  ["item 3 skip the current-suggestion check", "OCRP_STALE a retry", "OCRP_STALE a not-current id cannot be dismissed", http,
    "if (!current || current.id !== id)", "if (!current)"],
  ["item 3 a random submission id", "OCRP_STALE a retry", "OCRP_STALE a retry of the same form redirects", http,
    "submissionId: submitted,", "submissionId: String(Math.random()),"],
  ["item 4 write the civil ID on dismiss", "OCRP_DISMISS dismiss", "OCRP_DISMISS writes no civil ID", http,
    'if (how === "dismissed") {', 'if (how === "dismissed") { await service.civilId.save({ principalId: principal, submissionId: submitted, revision: (await service.civilId.readOwn(principal))?.revision ?? 0, expiry: current.expiry ?? undefined });'],
  ["item 5 skip the Origin check", "OCRP_ORIGIN only", "OCRP_ORIGIN a wrong Origin is 403", http,
    "request.headers.origin !== origin", "false"],
  ["item 6 put the number in a hidden field", "OCRP_SECRECY the plain number", "OCRP_SECRECY no form carries a number field", http,
    'const hidden = `<input type="hidden" name="suggestionId"', 'const hidden = `<input type="hidden" name="number" value="${esc(suggestion.last4 ?? "")}"><input type="hidden" name="suggestionId"'],
  ["item 7 read the suggestion twice", "OCRP_SHOWN My profile makes", "OCRP_SHOWN one suggestion read per My profile render", gateway,
    "civilIdSuggestion = await login.civilIdSuggestion.current(requesterPrincipalId) ?? undefined;",
    "civilIdSuggestion = (await login.civilIdSuggestion.current(requesterPrincipalId), await login.civilIdSuggestion.current(requesterPrincipalId)) ?? undefined;"],
  ["place the line twice", "OCRP_PLACE the line", "OCRP_PLACE exactly one suggestion row", webUi,
    "renderCivilIdSuggestion(language, civilIdSuggestion)", "renderCivilIdSuggestion(language, civilIdSuggestion) + renderCivilIdSuggestion(language, civilIdSuggestion)"],
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
console.log(`${cases.length}/${cases.length} civil ID suggestion mutants killed by their named assertions`);
