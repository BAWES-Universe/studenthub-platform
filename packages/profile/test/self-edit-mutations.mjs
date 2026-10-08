import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// SHU-143: every rule of the self-edit domain must be load-bearing. Each mutation
// rewrites a built module in place, the named test must fail by assertion, and
// the module is restored before the next.
const suite = fileURLToPath(new URL("../../../dist/packages/profile/test/self-edit.test.js", import.meta.url));
const selfEdit = new URL("../dist/self-edit.js", import.meta.url);
const completeness = new URL("../dist/completeness.js", import.meta.url);
const mutations = [
  [selfEdit, "route the introduction's confirm around its preview", "SHU143_CONFORMANCE",
    "? implementation.confirm(request) : { ok: false, reason: \"invalid_value\" },",
    "? (request.change.field === \"intro\" ? implementation.preview({ principalRef: request.principalRef, change: request.change }).then((p) => p.ok ? implementation.confirm({ ...request, token: p.token }) : p) : implementation.confirm(request)) : { ok: false, reason: \"invalid_value\" },"],
  [selfEdit, "skip the value check at confirm", "SHU143_VALUE_CHECKED",
    "confirm: async (request) => await acceptable(request.change.field, request.change.value)",
    "confirm: async (request) => true"],
  [selfEdit, "drop the upper age bound", "SHU143_AGE_RULE",
    "age < rule.minYears || age > rule.maxYears", "age < rule.minYears"],
  [selfEdit, "accept a one-word name", "SHU143_NORMALIZE",
    "name !== undefined && name.includes(\" \") ? name : undefined", "name"],
  [selfEdit, "let any code point through the introduction", "SHU143_TEXT_RULE",
    "if (allowNewline && code === 0x0a)", "if (allowNewline)"],
  [selfEdit, "let any grant edit a candidate profile", "SHU143_OWNER",
    "rows.some((row) => row.role === \"candidate\")", "rows.length > 0"],
  [completeness, "drop the conditional Kuwaiti-mother requirement", "SHU143_COMPLETENESS",
    "facts.nationalityKuwaiti === false && !recorded(\"kuwaiti_mother\")", "false"],
  [completeness, "drop the education requirement", "SHU143_COMPLETENESS",
    "need(facts.educationCount === 0, \"education\");", ""],
];
const originals = new Map();
for (const [file] of mutations) if (!originals.has(file.href)) originals.set(file.href, await readFile(file, "utf8"));
const restore = async () => { for (const [href, text] of originals) await writeFile(new URL(href), text); };
const run = (pattern) => spawnSync(process.execPath, ["--test-reporter=tap",
  ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], { encoding: "utf8", timeout: 120_000 });
try {
  assert.equal(run().status, 0, "the unmutated suite passes");
  for (const [file, name, pattern, from, to] of mutations) {
    const original = originals.get(file.href);
    assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
    await writeFile(file, original.replace(from, to));
    const result = run(pattern);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `${name}: mutation survived\n${output}`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named test did not fail\n${output}`);
    assert.match(output, /AssertionError|ERR_ASSERTION/, `${name}: did not die by assertion\n${output}`);
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
    await restore();
  }
} finally {
  await restore();
}
assert.equal(run().status, 0, "the restored suite passes");
process.stdout.write(`${mutations.length}/${mutations.length} SHU-143 self-edit mutations killed\n`);
