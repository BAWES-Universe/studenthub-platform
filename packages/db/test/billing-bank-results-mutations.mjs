import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Bank result files (F5), stored part: every guard between an uploaded file and a
// paid flag must be load-bearing. Each mutant rewrites the built store, the named
// test must fail by assertion, and the store is restored before the next.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the bank result mutations");
const store = new URL("../dist/billing/postgres-bank-result-store.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-billing-bank-results.test.js", import.meta.url));
const mutations = [
  ["settle a line the company has not paid in", "BANK_STORE_ELIGIBLE",
    "&& ELIGIBLE.has(transfer.status)", ""],
  ["read lines of transfers that were not locked", "BANK_STORE_ELIGIBLE",
    "AND transfer_id = ANY($2::text[])", "AND $2::text[] IS NOT NULL"],
  ["forget recorded confirmations from earlier files", "BANK_STORE_REPLAY",
    "WHERE reference = ANY($1::text[])", "WHERE false AND reference = ANY($1::text[])"],
  ["never complete a settled transfer", "BANK_STORE_PAY",
    'if (locked.get(id)?.status !== "distributing" ||', 'if (true ||'],
  ["keep paid flags when completion is refused", "BANK_STORE_ATOMIC",
    'throw new Error("bank_result_complete_refused");', "{}"],
  ["record a zero amount for an AUB confirmation", "BANK_STORE_PAY",
    "row.amount ?? line.paidAmount", 'row.amount ?? "0.000"'],
  ["settle lines without the actor's permission on their transfer", "BANK_STORE_AUTHORIZE",
    'if (!await tx.authorize(actor, transfer, "complete"))', "if (false)"],
  ["let any grant settle any company's transfer", "BANK_STORE_POLICY",
    "return decision(grants, transfer.companyId, after.slice(1));", "return true;"],
  ["commit a preview", "BANK_STORE_PREVIEW",
    '(result) => result.kind === "applied");', '(result) => result.kind !== "refused");'],
  ["apply an outcome other than the reviewed one", "BANK_STORE_REVIEW_BOUND",
    "if (reviewId !== review.reviewId)", "if (false)"],
  ["show a file's recorded lines to any reader", "BANK_STORE_READER_SCOPED",
    "lineIds: r.line_ids.filter((id) => visible.has(id))", "lineIds: r.line_ids"],
  ["upload without finance file permission", "BANK_STORE_GATE",
    "            if (!await this.gate(client, actor.principalId))\n                return { kind: \"refused\", code: \"forbidden\" };\n            const inserted", "            const inserted"],
  ["apply without finance file permission", "BANK_STORE_GATE",
    "        if (!await this.gate(client, actor.principalId))\n            return { kind: \"refused\", code: \"forbidden\" };\n        const file", "        const file"],
  ["name lines the actor may not settle", "BANK_STORE_SCOPED_REPLAY",
    "lineIds: d.lineIds.filter((id) => visible.has(id))", "lineIds: d.lineIds"],
  ["apply files without global serialisation", "BANK_STORE_RACE",
    "await client.query(\"SELECT pg_advisory_xact_lock($1)\", [APPLY_LOCK]);", ""],
  ["accept a self-only finance grant as file authority", "BANK_STORE_CENTRAL_GATE",
    "AND scope = 'subtree' ", ""],
  ["accept cover of some operator organizations", "BANK_STORE_CENTRAL_GATE",
    "return operators.every((operator) =>", "return operators.some((operator) =>"],
  ["accept an empty operator list", "BANK_STORE_CENTRAL_GATE",
    "if (operators.length === 0)\n            return false;", ""],
  ["let an act-as session apply a file", "BANK_STORE_REFUSED",
    "async run(actor, fileId, reviewId) {\n        if (actor.actingAs !== false ||", "async run(actor, fileId, reviewId) {\n        if ("],
  ["let an act-as session upload a file", "BANK_STORE_REFUSED",
    "async submit(actor, input) {\n        if (actor.actingAs !== false ||", "async submit(actor, input) {\n        if ("],
];
const original = await readFile(store, "utf8");
const run = (pattern) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1",
  ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], { encoding: "utf8", timeout: 120_000 });
let killed = 0;
try {
  assert.equal(run().status, 0, "the unmutated suite passes");
  for (const [name, pattern, from, to] of mutations) {
    assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
    await writeFile(store, original.replace(from, to));
    const result = run(pattern);
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name}: mutation survived\n${output}`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named test did not fail\n${output}`);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: infrastructure failure\n${output}`);
    assert.match(output, /AssertionError|ERR_ASSERTION/, `${name}: did not die by assertion\n${output}`);
    killed++;
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
    await writeFile(store, original);
  }
} finally { await writeFile(store, original); }
assert.equal(run().status, 0, "the restored suite passes");
process.stdout.write(`${killed}/${mutations.length} bank result store mutations killed\n`);
