// Recruit R3: each people-search rule is pinned by a mutant its named test kills.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../dist/packages/recruit/src/search.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/recruit/test/search.test.js", import.meta.url));
const mutations = [
  ["company-search", "REC3_DECISION", 'row.scope === "subtree" && operators.includes(row.org_id)', 'row.scope === "subtree"'],
  ["owner-search", "REC3_DECISION", '["staff", "admin", "recruiter"].includes(row.role)', '["staff", "admin", "recruiter", "org-owner"].includes(row.role)'],
  ["unknown-keys", "REC3_PARSE", "!KEYS.has(k) && raw[k] !== undefined", "false"],
  ["many-values", "REC3_PARSE", "out.length <= SEARCH_VALUES_MAX", "out.length <= SEARCH_VALUES_MAX + 1"],
  ["page-cap", "REC3_PARSE", "pageNumber > SEARCH_PAGE_MAX", "pageNumber > SEARCH_PAGE_MAX + 1"],
  ["not-looking", "REC3_PARSE", 'export const SEARCH_AVAILABILITY = ["active", "open_to_offers"];', 'export const SEARCH_AVAILABILITY = ["active", "open_to_offers", "not_looking"];'],
  ["no-dedupe", "REC3_PARSE", "const out = [...new Set(", "const out = [...("],
  ["drop-selected", "REC3_FACETS", "if (!values.some((v) => v.value === value))", "if (false)"],
  ["unsorted-facets", "REC3_FACETS", "b.count - a.count ||", "0 ||"],
  ["unsorted-universities", "REC3_VIEW", "universities: [...row.universities].sort()", "universities: [...row.universities]"],
  ["page-one-param", "REC3_VIEW", "if (page > 1)", "if (page >= 1)"],
];
function run(pattern, module) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], {
    encoding: "utf8", env: { ...process.env, ...(module ? { REC3_SEARCH_MODULE: module } : {}) }, timeout: 30000,
  });
  return { ...r, output: r.stdout + r.stderr };
}
assert.equal(run().status, 0, "unmutated suite passes");
for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../../../dist/packages/recruit/src/search-mutation-${process.pid}.js`, import.meta.url);
  try {
    await writeFile(target, original.replace(from, to));
    const r = run(pattern, `${target.href}?mutation=${encodeURIComponent(name)}`);
    assert.notEqual(r.status, 0, `${name} survived\n${r.output}`);
    assert.match(r.output, new RegExp(`not ok \\d+ - ${pattern} `));
  } finally {
    await unlink(target).catch(() => {});
  }
}
assert.equal(run().status, 0);
process.stdout.write(`${mutations.length}/${mutations.length} recruit search mutations killed\n`);
