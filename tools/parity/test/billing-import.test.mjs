import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = join(here, "../fixtures/billing");
const moduleUrl = process.env.SHU268_TEST_MODULE
  ?? pathToFileURL(join(here, "../billing-import-reconcile.mjs")).href;
const sourceFilePath = fileURLToPath(moduleUrl);
const { reconcileBillingFixture } = await import(moduleUrl);

async function fixture(name) {
  return JSON.parse(await readFile(join(fixtureDirectory, name), "utf8"));
}

function group(report, id) {
  return report.groups.find((candidate) => candidate.parentTransferId === id);
}

test("SHU-268/happy-reconcile-exactly-once", async () => {
  const report = reconcileBillingFixture(await fixture("reconciled.json"));
  const billingGroup = group(report, 100);
  assert.equal(report.status, "ready");
  assert.equal(report.summary.eligibleLineCount, 3);
  assert.equal(report.summary.representedLineCount, 3);
  assert.equal(billingGroup.assertions.everyEligibleLineExactlyOnce, true);
  assert.deepEqual(billingGroup.importPlan.lines.map((line) => line.payableLineRef), [1001, 1002, 1003]);
});

test("SHU-268/parent-child-no-double-count", async () => {
  const report = reconcileBillingFixture(await fixture("reconciled.json"));
  const billingGroup = group(report, 100);
  assert.equal(report.rootSelection.predicate, "parent_transfer_id IS NULL");
  assert.deepEqual(report.rootSelection.transferIds, [100]);
  assert.equal(billingGroup.reconciliation.parentCompanyTotal, "30.000");
  assert.equal(billingGroup.reconciliation.comparisonTotal, "30.000");
  assert.equal(billingGroup.reconciliation.reconciles, true);
  assert.deepEqual(billingGroup.reconciliation.children, [
    { transferId: 101, companyId: 11, companyTotal: "10.000", filteredParentLineTotal: "10.000", reconciles: true },
    { transferId: 102, companyId: 12, companyTotal: "20.000", filteredParentLineTotal: "20.000", reconciles: true }
  ]);
  assert.equal(billingGroup.assertions.parentAndChildTotalsWithoutDoubleCount, true);

  const mismatch = await fixture("reconciled.json");
  mismatch.transfer_candidates[0].company_total = "9.000";
  const blocked = reconcileBillingFixture(mismatch);
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.failures.some((failure) =>
    failure.code === "child-line-total-mismatch" && failure.recordId === 101));
});

test("SHU-268/child-filtering-and-provenance", async () => {
  const report = reconcileBillingFixture(await fixture("reconciled.json"));
  const lines = group(report, 100).importPlan.lines;
  assert.deepEqual(lines, [
    { payableLineRef: 1001, sourceTransferId: 100, orgId: 11, storeId: 111, companyTotal: "10.000", representedByTransferId: 101 },
    { payableLineRef: 1002, sourceTransferId: 100, orgId: 12, storeId: 121, companyTotal: "7.500", representedByTransferId: 102 },
    { payableLineRef: 1003, sourceTransferId: 100, orgId: 12, storeId: 122, companyTotal: "12.500", representedByTransferId: 102 }
  ]);
});

test("SHU-268/parent-own-lines-reported", async () => {
  const report = reconcileBillingFixture(await fixture("mismatch-parent-own.json"));
  const billingGroup = group(report, 200);
  assert.deepEqual(billingGroup.parentOwnLines, {
    count: 2,
    companyTotal: "6.000",
    outcome: "omitted",
    evidenceInvoiceNumbers: []
  });
  assert.equal(billingGroup.importable, false);
});

test("SHU-268/parent-own-lines-invoiced-positive-control", async () => {
  const report = reconcileBillingFixture(await fixture("parent-direct.json"));
  const billingGroup = group(report, 300);
  assert.equal(report.status, "ready");
  assert.equal(billingGroup.parentOwnLines.outcome, "invoiced");
  assert.deepEqual(billingGroup.parentOwnLines.evidenceInvoiceNumbers, ["LEGACY-7001"]);
});

test("SHU-268/parent-own-lines-ambiguous", async () => {
  const report = reconcileBillingFixture(await fixture("parent-ambiguous.json"));
  const billingGroup = group(report, 400);
  assert.equal(report.status, "blocked");
  assert.equal(billingGroup.parentOwnLines.outcome, "ambiguous");
  assert.deepEqual(billingGroup.parentOwnLines.evidenceInvoiceNumbers, ["LEGACY-8001"]);
  assert.ok(report.failures.some((failure) => failure.code === "parent-own-lines-ambiguous"));
});

test("SHU-268/import-mismatch-reports", async () => {
  const report = reconcileBillingFixture(await fixture("mismatch-parent-own.json"));
  const billingGroup = group(report, 200);
  assert.equal(report.status, "blocked");
  assert.equal(billingGroup.reconciliation.reconciles, false);
  assert.equal(billingGroup.importPlan, null);
  assert.ok(report.failures.some((failure) => failure.code === "parent-child-total-mismatch" && failure.parentTransferId === 200));
});

test("SHU-268/regenerated-legacy-identifiers", async () => {
  const report = reconcileBillingFixture(await fixture("reconciled.json"));
  const documents = group(report, 100).importPlan.documents;
  assert.deepEqual(documents.map(({ invoiceNumber, state, supersededBy }) => ({ invoiceNumber, state, supersededBy })), [
    { invoiceNumber: "LEGACY-5001", state: "voided", supersededBy: "LEGACY-5002" },
    { invoiceNumber: "LEGACY-5002", state: "issued", supersededBy: null },
    { invoiceNumber: "LEGACY-5003", state: "issued", supersededBy: null }
  ]);
  assert.equal(new Set(documents.map((document) => document.invoiceNumber)).size, documents.length);
});

test("SHU-268/voided-history-preserved", async () => {
  const report = reconcileBillingFixture(await fixture("reconciled.json"));
  const document = group(report, 100).importPlan.documents.find((candidate) => candidate.invoiceNumber === "LEGACY-5001");
  assert.deepEqual(document, {
    invoiceNumber: "LEGACY-5001",
    sourceInvoiceId: 5001,
    sourceTransferId: 101,
    orgId: 11,
    kind: "subtotal",
    companyTotal: "10.000",
    state: "voided",
    supersededBy: "LEGACY-5002",
    immutable: true
  });
});

test("SHU-268/legacy-namespace", async () => {
  const valid = reconcileBillingFixture(await fixture("reconciled.json"));
  assert.equal(valid.assertions.legacyNamespaceDisjoint, true);
  assert.ok(group(valid, 100).importPlan.documents.every((document) => document.invoiceNumber.startsWith("LEGACY-")));
  const collision = await fixture("reconciled.json");
  collision.newInvoiceNumbers.push("LEGACY-9999");
  const blocked = reconcileBillingFixture(collision);
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.failures.some((failure) => failure.code === "legacy-namespace-collision"));
});

test("SHU-268/deleted-records-fail-closed", async () => {
  const input = await fixture("reconciled.json");
  input.transfers.find((transfer) => transfer.transfer_id === 102).deleted = 1;
  const report = reconcileBillingFixture(input);
  assert.equal(report.status, "blocked");
  assert.equal(report.summary.importableGroupCount, 0);
  assert.ok(report.failures.some((failure) => failure.code === "deleted-transfer" && failure.recordId === 102));

  const deletedLine = await fixture("reconciled.json");
  deletedLine.transfer_candidates[0].deleted = 1;
  const lineReport = reconcileBillingFixture(deletedLine);
  assert.equal(lineReport.status, "blocked");
  assert.ok(lineReport.failures.some((failure) => failure.code === "deleted-transfer-candidate" && failure.recordId === 1001));
});

test("SHU-268/deleted-invoice-requires-single-successor", async () => {
  const input = await fixture("reconciled.json");
  input.invoices = input.invoices.filter((invoice) => invoice.invoice_id !== 5002);
  const report = reconcileBillingFixture(input);
  assert.equal(report.status, "blocked");
  assert.equal(report.summary.importableGroupCount, 0);
  assert.ok(report.failures.some((failure) =>
    failure.code === "deleted-invoice-without-single-successor" && failure.recordId === 101));
});

test("SHU-268/duplicate-records-fail-closed", async () => {
  const input = await fixture("reconciled.json");
  input.transfer_candidates.push({ ...input.transfer_candidates[0] });
  const report = reconcileBillingFixture(input);
  assert.equal(report.status, "blocked");
  assert.equal(report.summary.importableGroupCount, 0);
  assert.ok(report.failures.some((failure) => failure.code === "duplicate-transfer-candidate" && failure.recordId === 1001));

  const duplicateActive = await fixture("reconciled.json");
  duplicateActive.invoices.push({ invoice_id: 5004, transfer_id: 101, deleted: 0 });
  const invoiceReport = reconcileBillingFixture(duplicateActive);
  assert.equal(invoiceReport.status, "blocked");
  assert.ok(invoiceReport.failures.some((failure) =>
    failure.code === "duplicate-active-invoice" && failure.recordId === 101));
});

test("SHU-268/malformed-records-fail-closed", async () => {
  const input = await fixture("reconciled.json");
  input.transfer_candidates[0].company_total = "10.00";
  input.transfer_candidates[1].store_id = null;
  const report = reconcileBillingFixture(input);
  assert.equal(report.status, "blocked");
  assert.equal(report.summary.importableGroupCount, 0);
  assert.ok(report.failures.some((failure) => failure.code === "malformed-decimal"));
  assert.ok(report.failures.some((failure) => failure.code === "malformed-id" && failure.field === "store_id"));

  const wrongSource = await fixture("reconciled.json");
  wrongSource.sourceKind = "production";
  const sourceReport = reconcileBillingFixture(wrongSource);
  assert.equal(sourceReport.status, "blocked");
  assert.ok(sourceReport.failures.some((failure) => failure.code === "unapproved-source-kind"));
});

test("SHU-268/cross-company-records-fail-closed", async () => {
  const input = await fixture("reconciled.json");
  input.transfer_candidates[0].company_id = 999;
  const report = reconcileBillingFixture(input);
  assert.equal(report.status, "blocked");
  assert.equal(report.summary.importableGroupCount, 0);
  assert.ok(report.failures.some((failure) => failure.code === "cross-company-line" && failure.recordId === 1001));
});

test("SHU-268/rerun-idempotent-and-input-immutable", async () => {
  const input = await fixture("reconciled.json");
  const before = structuredClone(input);
  const first = reconcileBillingFixture(input);
  const second = reconcileBillingFixture(input);
  assert.deepEqual(second, first);
  assert.deepEqual(input, before);
});

test("SHU-268/order-independent", async () => {
  const input = await fixture("reconciled.json");
  const expected = reconcileBillingFixture(input);
  input.transfers.reverse();
  input.transfer_candidates.reverse();
  input.invoices.reverse();
  input.newInvoiceNumbers.reverse();
  assert.deepEqual(reconcileBillingFixture(input), expected);
});

test("SHU-268/cli-machine-readable-and-read-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shu268-cli-"));
  try {
    const path = join(directory, "fixture.json");
    const body = JSON.stringify(await fixture("reconciled.json"), null, 2);
    await writeFile(path, body);
    const command = spawnSync(process.execPath, [fileURLToPath(moduleUrl), path], { encoding: "utf8", timeout: 10_000 });
    assert.equal(command.error, undefined);
    assert.equal(command.status, 0, command.stderr);
    assert.doesNotMatch(command.stderr, /usage:|fixture-read-failed/);
    assert.equal(JSON.parse(command.stdout).status, "ready");
    assert.equal(await readFile(path, "utf8"), body);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SHU-268/no-production-or-write-capabilities", async () => {
  const source = await readFile(sourceFilePath, "utf8");
  assert.match(source, /from "node:fs\/promises"/);
  assert.doesNotMatch(source, /\b(writeFile|appendFile|createWriteStream|fetch|http|https|net|postgres|database|child_process)\b/);
  assert.doesNotMatch(source, /@studenthub\/(db|legacy-import)/);
});
