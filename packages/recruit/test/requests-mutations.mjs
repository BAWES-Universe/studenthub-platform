// Recruit R1: each rule of the request domain is pinned by a mutant its named test kills.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../dist/packages/recruit/src/requests.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/recruit/test/requests.test.js", import.meta.url));
const mutations = [
  ["extra-pair", "REC1_TRANSITIONS", '["filled", "closed"],', '["filled", "closed"],\n    ["closed", "open"],'],
  ["missing-rework", "REC1_TRANSITIONS", '["filled", "filling"],', ""],
  ["any-pair", "REC1_TRANSITIONS", "return REQUEST_TRANSITIONS.some(([a, b]) => a === from && b === to);", "return from !== to;"],
  ["rework-map", "REC1_LEGACY_MAP", 'case "re_work": return { kind: "mapped", status: "filling", closeReason: null };', 'case "re_work": return { kind: "mapped", status: "open", closeReason: null };'],
  ["cancel-map", "REC1_LEGACY_MAP", 'case "cancelled": return { kind: "mapped", status: "closed", closeReason: "cancelled" };', 'case "cancelled": return { kind: "mapped", status: "closed", closeReason: "fulfilled" };'],
  ["guess", "REC1_LEGACY_MAP", "default: return { kind: \"unmapped\", value };", "default: return { kind: \"mapped\", status: \"open\", closeReason: null };"],
  ["recruiter-closes", "REC1_CANCEL", 'const CLOSE_ROLES = ["staff", "admin", "org-owner"];', 'const CLOSE_ROLES = ["staff", "admin", "org-owner", "recruiter"];'],
  ["subtree", "REC1_CANCEL", '(row.scope === "subtree" && ancestors.includes(row.org_id))', "ancestors.includes(row.org_id)"],
  ["operator", "REC1_CANCEL", "return !operators.includes(orgId) && covers(rows, CREATE_ROLES, orgId, ancestors);", "return covers(rows, CREATE_ROLES, orgId, ancestors);"],
  ["staff-scope", "REC1_STAFF", 'row.scope === "subtree" && operators.includes(row.org_id)', "operators.includes(row.org_id)"],
  ["trim", "REC1_CREATE", "const trimmed = value.trim();", "const trimmed = value;"],
  ["period-order", "REC1_CREATE", "if (periodStart !== null && periodEnd !== null && periodEnd < periodStart)", "if (false)"],
  ["unknown-keys", "REC1_CREATE", "if (Object.keys(r).some((key) => !FIELD_KEYS.includes(key)))\n        return undefined;", ""],
  ["close-reason", "REC1_TRANSITION_BODY", "return closeReason === undefined ? undefined : { to, closeReason };", "return { to, closeReason: closeReason ?? null };"],
  ["offer-all", "REC1_VIEW", "REQUEST_TRANSITIONS.filter(([from]) => from === row.status)", "REQUEST_TRANSITIONS.filter(() => true)"],
];
function run(pattern, module) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], {
    encoding: "utf8", env: { ...process.env, ...(module ? { REC1_REQUESTS_MODULE: module } : {}) }, timeout: 30000,
  });
  return { ...r, output: r.stdout + r.stderr };
}
assert.equal(run().status, 0, "unmutated suite passes");
for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../../../dist/packages/recruit/src/requests-mutation-${process.pid}.js`, import.meta.url);
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
process.stdout.write(`${mutations.length}/${mutations.length} recruit request mutations killed\n`);
