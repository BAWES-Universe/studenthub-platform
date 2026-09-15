import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "../billing-import-reconcile.mjs");
const testPath = join(here, "billing-import.test.mjs");
const mutations = [
  {
    name: "process children as root billing groups",
    pattern: "SHU-268/parent-child-no-double-count",
    from: "const rootTransfers = transfers.filter((transfer) => transfer.parent_transfer_id === null);",
    to: "const rootTransfers = transfers;"
  },
  {
    name: "stop filtering parent lines by child company",
    pattern: "SHU-268/child-filtering-and-provenance",
    from: "const child = childByCompany.get(line.company_id);",
    to: "const child = children[0];"
  },
  {
    name: "drop company provenance",
    pattern: "SHU-268/child-filtering-and-provenance",
    from: "orgId: line.company_id,",
    to: "orgId: 999,"
  },
  {
    name: "drop store provenance",
    pattern: "SHU-268/child-filtering-and-provenance",
    from: "storeId: line.store_id,",
    to: "storeId: null,"
  },
  {
    name: "represent each eligible line twice",
    pattern: "SHU-268/happy-reconcile-exactly-once",
    from: "const importedLines = mappedLines.map(({ representedByTransferId, ...line }) => ({ ...line, representedByTransferId }));",
    to: "const importedLines = mappedLines.flatMap(({ representedByTransferId, ...line }) => [{ ...line, representedByTransferId }, { ...line, representedByTransferId }]);"
  },
  {
    name: "auto-correct parent child mismatch",
    pattern: "SHU-268/import-mismatch-reports",
    from: "const totalsReconcile = comparisonMilli === parentTotalMilli && childLinesReconcile;",
    to: "const totalsReconcile = true && childLinesReconcile;"
  },
  {
    name: "ignore child totals that disagree with filtered parent lines",
    pattern: "SHU-268/parent-child-no-double-count",
    from: "reconciles: filteredLineMilli === childTotalMilli",
    to: "reconciles: true"
  },
  {
    name: "exclude parent-owned lines from measurement",
    pattern: "SHU-268/parent-own-lines-reported",
    from: "const parentOwn = eligibleLines.filter((line) => line.company_id === parent.company_id);",
    to: "const parentOwn = [];"
  },
  {
    name: "assume ambiguous parent invoice means omitted",
    pattern: "SHU-268/parent-own-lines-ambiguous",
    from: "parentOutcome = parentInvoices.length > 0 ? \"ambiguous\" : \"omitted\";",
    to: "parentOutcome = \"omitted\";"
  },
  {
    name: "accept an unexpected consolidated parent invoice",
    pattern: "SHU-268/unexpected-parent-invoice-fails-closed",
    from: "if (children.length > 0 && parentOwn.length === 0 && parentInvoices.length > 0) {",
    to: "if (false) {"
  },
  {
    name: "ignore deleted transfers",
    pattern: "SHU-268/deleted-records-fail-closed",
    from: "if (row?.deleted === 1) failures.push(failure(\"deleted-transfer\", { recordType: \"transfer\", recordId: id }));",
    to: "if (false) failures.push(failure(\"deleted-transfer\", { recordType: \"transfer\", recordId: id }));"
  },
  {
    name: "ignore deleted payable lines",
    pattern: "SHU-268/deleted-records-fail-closed",
    from: "if (row?.deleted === 1) failures.push(failure(\"deleted-transfer-candidate\", { recordType: \"transfer-candidate\", recordId: id }));",
    to: "if (false) failures.push(failure(\"deleted-transfer-candidate\", { recordType: \"transfer-candidate\", recordId: id }));"
  },
  {
    name: "accept duplicate records",
    pattern: "SHU-268/duplicate-records-fail-closed",
    from: "if (index.has(key)) {",
    to: "if (false) {"
  },
  {
    name: "accept duplicate active invoices",
    pattern: "SHU-268/duplicate-records-fail-closed",
    from: "if (active.length > 1) {",
    to: "if (false) {"
  },
  {
    name: "accept malformed decimals",
    pattern: "SHU-268/malformed-records-fail-closed",
    from: "if (typeof value === \"string\" && DECIMAL_RE.test(value)) return true;",
    to: "if (typeof value === \"string\") return true;"
  },
  {
    name: "accept an unapproved production source marker",
    pattern: "SHU-268/malformed-records-fail-closed",
    from: "if (input.sourceKind !== \"synthetic\") failures.push(failure(\"unapproved-source-kind\"));",
    to: "if (false) failures.push(failure(\"unapproved-source-kind\"));"
  },
  {
    name: "accept cross-company payable lines",
    pattern: "SHU-268/cross-company-records-fail-closed",
    from: "if (!companies.has(line.company_id)) {",
    to: "if (false) {"
  },
  {
    name: "strip reserved LEGACY namespace",
    pattern: "SHU-268/legacy-namespace",
    from: "return `LEGACY-${invoiceId}`;",
    to: "return String(invoiceId);"
  },
  {
    name: "drop soft-deleted invoice history",
    pattern: "SHU-268/voided-history-preserved",
    from: "const groupInvoices = fixture.invoices.filter((invoice) => groupTransferIds.has(invoice.transfer_id));",
    to: "const groupInvoices = fixture.invoices.filter((invoice) => groupTransferIds.has(invoice.transfer_id) && invoice.deleted === 0);"
  },
  {
    name: "resolve retired invoice to itself",
    pattern: "SHU-268/regenerated-legacy-identifiers",
    from: "supersededBy: invoice.deleted === 1 ? legacyInvoiceNumber(active[0].invoice_id) : null,",
    to: "supersededBy: invoice.deleted === 1 ? legacyInvoiceNumber(invoice.invoice_id) : null,"
  },
  {
    name: "make document mutable",
    pattern: "SHU-268/voided-history-preserved",
    from: "immutable: true",
    to: "immutable: false"
  },
  {
    name: "preserve fixture line order",
    pattern: "SHU-268/order-independent",
    from: ".sort((left, right) => stableCompare(left.tc_id, right.tc_id));",
    to: ".sort(() => 0);"
  },
  {
    name: "add per-run nondeterminism",
    pattern: "SHU-268/rerun-idempotent-and-input-immutable",
    from: "fixtureId: fixture.fixtureId,\n    sourceKind: fixture.sourceKind,\n    mode: \"read-only\",",
    to: "fixtureId: fixture.fixtureId,\n    sourceKind: fixture.sourceKind,\n    runNonce: Math.random(),\n    mode: \"read-only\","
  },
  {
    name: "add a filesystem write capability",
    pattern: "SHU-268/no-production-or-write-capabilities",
    from: "import { readFile } from \"node:fs/promises\";",
    to: "import { readFile, writeFile } from \"node:fs/promises\";"
  }
];

const original = await readFile(sourcePath, "utf8");
for (const mutation of mutations) {
  const directory = await mkdtemp(join(tmpdir(), "shu268-mutation-"));
  try {
    assert.equal(original.split(mutation.from).length - 1, 1, `${mutation.name}: mutation binds exactly once`);
    const mutatedPath = join(directory, "billing-import-reconcile.mjs");
    await writeFile(mutatedPath, original.replace(mutation.from, mutation.to));
    const run = spawnSync(process.execPath, [
      "--test",
      "--test-reporter=tap",
      `--test-name-pattern=^${mutation.pattern}$`,
      testPath
    ], {
      encoding: "utf8",
      env: { ...process.env, SHU268_TEST_MODULE: pathToFileURL(mutatedPath).href },
      timeout: 20_000
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.error, undefined, `${mutation.name}: runner error`);
    assert.equal(run.signal, null, `${mutation.name}: runner signal`);
    assert.notEqual(run.status, 0, `${mutation.name}: mutation survived`);
    assert.match(output, new RegExp(`not ok \\d+ - ${mutation.pattern.replaceAll("/", "\\/")}`), `${mutation.name}: named assertion did not fail\n${output}`);
    assert.match(output, /AssertionError|ERR_ASSERTION/, `${mutation.name}: no assertion failure\n${output}`);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/, `${mutation.name}: infrastructure failure\n${output}`);
    process.stdout.write(`KILLED ${mutation.name} -> ${mutation.pattern}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

process.stdout.write(`${mutations.length}/${mutations.length} SHU-268 mutations killed\n`);
