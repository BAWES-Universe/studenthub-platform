#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DECIMAL_RE = /^(0|[1-9][0-9]{0,8})\.[0-9]{3}$/;
const LEGACY_PREFIX = "LEGACY-";

function stableCompare(left, right) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function moneyToMilli(value) {
  const [whole, fraction] = value.split(".");
  return BigInt(whole) * 1000n + BigInt(fraction);
}

function milliToMoney(value) {
  const whole = value / 1000n;
  const fraction = String(value % 1000n).padStart(3, "0");
  return `${whole}.${fraction}`;
}

function legacyInvoiceNumber(invoiceId) {
  return `LEGACY-${invoiceId}`;
}

function failure(code, details = {}) {
  return { code, ...details };
}

function isPositiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateId(row, recordType, recordId, field, failures, { nullable = false } = {}) {
  const value = row?.[field];
  if ((value === null && nullable) || isPositiveId(value)) return true;
  failures.push(failure("malformed-id", { recordType, recordId, field }));
  return false;
}

function validateDeleted(row, recordType, recordId, failures) {
  if (row?.deleted === 0 || row?.deleted === 1) return true;
  failures.push(failure("malformed-deleted-flag", { recordType, recordId }));
  return false;
}

function validateMoney(row, recordType, recordId, field, failures) {
  const value = row?.[field];
  if (typeof value === "string" && DECIMAL_RE.test(value)) return true;
  failures.push(failure("malformed-decimal", { recordType, recordId, field }));
  return false;
}

function indexRows(rows, keyField, recordType, failures) {
  const index = new Map();
  for (const row of rows) {
    const key = row?.[keyField];
    if (!isPositiveId(key)) continue;
    if (index.has(key)) {
      failures.push(failure(`duplicate-${recordType}`, { recordType, recordId: key }));
      continue;
    }
    index.set(key, row);
  }
  return index;
}

function sortFailures(failures) {
  return failures.sort((left, right) =>
    stableCompare(left.parentTransferId ?? 0, right.parentTransferId ?? 0)
    || stableCompare(left.recordType ?? "", right.recordType ?? "")
    || stableCompare(left.recordId ?? 0, right.recordId ?? 0)
    || stableCompare(left.code, right.code)
    || stableCompare(left.field ?? "", right.field ?? ""));
}

function emptyReport(fixtureId, sourceKind, newInvoiceNumbers, failures, rootTransferIds = []) {
  return {
    schemaVersion: 1,
    fixtureId: fixtureId ?? null,
    sourceKind: sourceKind ?? null,
    mode: "read-only",
    rootSelection: {
      predicate: "parent_transfer_id IS NULL",
      transferIds: rootTransferIds
    },
    status: "blocked",
    assertions: {
      legacyNamespaceDisjoint: !newInvoiceNumbers.some((number) =>
        typeof number === "string" && number.startsWith(LEGACY_PREFIX))
    },
    groups: [],
    failures: sortFailures(failures),
    summary: {
      rootTransferCount: rootTransferIds.length,
      eligibleLineCount: 0,
      representedLineCount: 0,
      importableGroupCount: 0,
      blockedGroupCount: rootTransferIds.length,
      failureCount: failures.length
    }
  };
}

function validateFixture(input) {
  const failures = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { fixture: {}, failures: [failure("malformed-fixture")], fatal: true };
  }

  if (input.schemaVersion !== 1) failures.push(failure("unsupported-schema-version"));
  if (input.sourceKind !== "synthetic") failures.push(failure("unapproved-source-kind"));
  if (typeof input.fixtureId !== "string" || input.fixtureId.length === 0) {
    failures.push(failure("malformed-fixture-id"));
  }

  for (const field of ["transfers", "transfer_candidates", "invoices", "newInvoiceNumbers"]) {
    if (!Array.isArray(input[field])) failures.push(failure("malformed-collection", { field }));
  }

  if (failures.some((candidate) => candidate.code === "malformed-collection")) {
    return { fixture: input, failures, fatal: true };
  }

  for (const row of input.transfers) {
    const id = row?.transfer_id ?? null;
    validateId(row, "transfer", id, "transfer_id", failures);
    validateId(row, "transfer", id, "parent_transfer_id", failures, { nullable: true });
    validateId(row, "transfer", id, "company_id", failures);
    validateMoney(row, "transfer", id, "company_total", failures);
    validateDeleted(row, "transfer", id, failures);
    if (row?.deleted === 1) failures.push(failure("deleted-transfer", { recordType: "transfer", recordId: id }));
  }

  for (const row of input.transfer_candidates) {
    const id = row?.tc_id ?? null;
    validateId(row, "transfer-candidate", id, "tc_id", failures);
    validateId(row, "transfer-candidate", id, "transfer_id", failures);
    validateId(row, "transfer-candidate", id, "company_id", failures);
    validateId(row, "transfer-candidate", id, "store_id", failures);
    validateMoney(row, "transfer-candidate", id, "company_total", failures);
    validateDeleted(row, "transfer-candidate", id, failures);
    if (row?.deleted === 1) failures.push(failure("deleted-transfer-candidate", { recordType: "transfer-candidate", recordId: id }));
  }

  for (const row of input.invoices) {
    const id = row?.invoice_id ?? null;
    validateId(row, "invoice", id, "invoice_id", failures);
    validateId(row, "invoice", id, "transfer_id", failures);
    validateDeleted(row, "invoice", id, failures);
  }

  for (const number of input.newInvoiceNumbers) {
    if (typeof number !== "string" || number.length === 0) {
      failures.push(failure("malformed-new-invoice-number"));
    } else if (number.startsWith(LEGACY_PREFIX)) {
      failures.push(failure("legacy-namespace-collision", { invoiceNumber: number }));
    }
  }
  if (new Set(input.newInvoiceNumbers).size !== input.newInvoiceNumbers.length) {
    failures.push(failure("duplicate-new-invoice-number"));
  }

  indexRows(input.transfers, "transfer_id", "transfer", failures);
  indexRows(input.transfer_candidates, "tc_id", "transfer-candidate", failures);
  indexRows(input.invoices, "invoice_id", "invoice", failures);
  return { fixture: input, failures, fatal: false };
}

function mapLine(line, representedByTransferId) {
  return {
    payableLineRef: line.tc_id,
    sourceTransferId: line.transfer_id,
    orgId: line.company_id,
    storeId: line.store_id,
    companyTotal: line.company_total,
    representedByTransferId
  };
}

function mapDocuments(invoices, transferIndex, childTransferIds) {
  const byTransfer = new Map();
  for (const invoice of invoices) {
    const rows = byTransfer.get(invoice.transfer_id) ?? [];
    rows.push(invoice);
    byTransfer.set(invoice.transfer_id, rows);
  }

  return invoices
    .slice()
    .sort((left, right) => stableCompare(left.invoice_id, right.invoice_id))
    .map((invoice) => {
      const transfer = transferIndex.get(invoice.transfer_id);
      const active = (byTransfer.get(invoice.transfer_id) ?? [])
        .filter((candidate) => candidate.deleted === 0)
        .sort((left, right) => stableCompare(left.invoice_id, right.invoice_id));
      return {
        invoiceNumber: legacyInvoiceNumber(invoice.invoice_id),
        sourceInvoiceId: invoice.invoice_id,
        sourceTransferId: invoice.transfer_id,
        orgId: childTransferIds.has(invoice.transfer_id) ? transfer.company_id : null,
        kind: childTransferIds.has(invoice.transfer_id) ? "subtotal" : "consolidated",
        companyTotal: transfer.company_total,
        state: invoice.deleted === 1 ? "voided" : "issued",
        supersededBy: invoice.deleted === 1 ? legacyInvoiceNumber(active[0].invoice_id) : null,
        immutable: true
      };
    });
}

export function reconcileBillingFixture(input) {
  const { fixture, failures, fatal } = validateFixture(input);
  const newInvoiceNumbers = Array.isArray(fixture.newInvoiceNumbers)
    ? fixture.newInvoiceNumbers.slice().sort(stableCompare)
    : [];
  const transfers = Array.isArray(fixture.transfers) ? fixture.transfers : [];
  const rootTransfers = transfers.filter((transfer) => transfer.parent_transfer_id === null);
  rootTransfers.sort((left, right) => stableCompare(left.transfer_id, right.transfer_id));
  const rootTransferIds = rootTransfers.map((transfer) => transfer.transfer_id);

  if (fatal || failures.length > 0) {
    return emptyReport(fixture.fixtureId, fixture.sourceKind, newInvoiceNumbers, failures, rootTransferIds);
  }

  const transferIndex = indexRows(transfers, "transfer_id", "transfer", failures);
  const invoiceIndex = indexRows(fixture.invoices, "invoice_id", "invoice", failures);
  indexRows(fixture.transfer_candidates, "tc_id", "transfer-candidate", failures);
  const roots = new Set(rootTransferIds);
  if (rootTransfers.length === 0) failures.push(failure("no-parent-transfer"));

  for (const transfer of transfers) {
    if (transfer.parent_transfer_id === null) continue;
    const parent = transferIndex.get(transfer.parent_transfer_id);
    if (!parent) {
      failures.push(failure("orphan-child-transfer", { recordType: "transfer", recordId: transfer.transfer_id }));
    } else if (!roots.has(parent.transfer_id)) {
      failures.push(failure("nested-child-transfer", { recordType: "transfer", recordId: transfer.transfer_id }));
    }
  }

  for (const line of fixture.transfer_candidates) {
    const owner = transferIndex.get(line.transfer_id);
    if (!owner) {
      failures.push(failure("orphan-transfer-candidate", { recordType: "transfer-candidate", recordId: line.tc_id }));
    } else if (owner.parent_transfer_id !== null) {
      failures.push(failure("line-not-owned-by-parent", { recordType: "transfer-candidate", recordId: line.tc_id }));
    }
  }

  for (const invoice of fixture.invoices) {
    if (!transferIndex.has(invoice.transfer_id)) {
      failures.push(failure("orphan-invoice", { recordType: "invoice", recordId: invoice.invoice_id }));
    }
  }

  const invoiceRowsByTransfer = new Map();
  for (const invoice of invoiceIndex.values()) {
    const rows = invoiceRowsByTransfer.get(invoice.transfer_id) ?? [];
    rows.push(invoice);
    invoiceRowsByTransfer.set(invoice.transfer_id, rows);
  }
  for (const [transferId, invoices] of invoiceRowsByTransfer) {
    const active = invoices.filter((invoice) => invoice.deleted === 0);
    if (active.length > 1) {
      failures.push(failure("duplicate-active-invoice", { recordType: "invoice", recordId: transferId }));
    }
    if (invoices.some((invoice) => invoice.deleted === 1) && active.length !== 1) {
      failures.push(failure("deleted-invoice-without-single-successor", { recordType: "invoice", recordId: transferId }));
    }
  }

  for (const parent of rootTransfers) {
    const children = transfers.filter((transfer) => transfer.parent_transfer_id === parent.transfer_id);
    const companies = new Set([parent.company_id]);
    for (const child of children) {
      if (companies.has(child.company_id)) {
        failures.push(failure("duplicate-group-company", {
          parentTransferId: parent.transfer_id,
          recordType: "transfer",
          recordId: child.transfer_id
        }));
      }
      companies.add(child.company_id);
    }
    for (const line of fixture.transfer_candidates.filter((candidate) => candidate.transfer_id === parent.transfer_id)) {
      if (!companies.has(line.company_id)) {
        failures.push(failure("cross-company-line", {
          parentTransferId: parent.transfer_id,
          recordType: "transfer-candidate",
          recordId: line.tc_id
        }));
      }
    }
  }

  if (failures.length > 0) {
    return emptyReport(fixture.fixtureId, fixture.sourceKind, newInvoiceNumbers, failures, rootTransferIds);
  }

  const groups = [];
  for (const parent of rootTransfers) {
    const groupFailures = [];
    const children = transfers
      .filter((transfer) => transfer.parent_transfer_id === parent.transfer_id)
      .sort((left, right) => stableCompare(left.transfer_id, right.transfer_id));
    const childTransferIds = new Set(children.map((child) => child.transfer_id));
    const childByCompany = new Map(children.map((child) => [child.company_id, child]));
    const eligibleLines = fixture.transfer_candidates
      .filter((line) => line.transfer_id === parent.transfer_id)
      .sort((left, right) => stableCompare(left.tc_id, right.tc_id));
    if (eligibleLines.length === 0) {
      groupFailures.push(failure("no-eligible-lines", { parentTransferId: parent.transfer_id }));
    }
    const parentOwn = eligibleLines.filter((line) => line.company_id === parent.company_id);
    const parentInvoices = (invoiceRowsByTransfer.get(parent.transfer_id) ?? [])
      .filter((invoice) => invoice.deleted === 0)
      .sort((left, right) => stableCompare(left.invoice_id, right.invoice_id));

    let parentOutcome = "none";
    if (parentOwn.length > 0 && children.length === 0) {
      parentOutcome = parentInvoices.length === 1 ? "invoiced" : "omitted";
    } else if (parentOwn.length > 0 && children.length > 0) {
      parentOutcome = parentInvoices.length > 0 ? "ambiguous" : "omitted";
    }

    if (parentOutcome === "ambiguous") {
      groupFailures.push(failure("parent-own-lines-ambiguous", { parentTransferId: parent.transfer_id }));
    }
    if (parentOutcome === "omitted") {
      groupFailures.push(failure("parent-own-lines-omitted", { parentTransferId: parent.transfer_id }));
    }

    const childReconciliation = children.map((child) => {
      const filteredLineMilli = eligibleLines
        .filter((line) => line.company_id === child.company_id)
        .reduce((sum, line) => sum + moneyToMilli(line.company_total), 0n);
      const childTotalMilli = moneyToMilli(child.company_total);
      return {
        transferId: child.transfer_id,
        companyId: child.company_id,
        companyTotal: child.company_total,
        filteredParentLineTotal: milliToMoney(filteredLineMilli),
        reconciles: filteredLineMilli === childTotalMilli
      };
    });
    const childLinesReconcile = childReconciliation.every((child) => child.reconciles);
    for (const child of childReconciliation.filter((candidate) => !candidate.reconciles)) {
      groupFailures.push(failure("child-line-total-mismatch", {
        parentTransferId: parent.transfer_id,
        recordType: "transfer",
        recordId: child.transferId,
        companyTotal: child.companyTotal,
        filteredParentLineTotal: child.filteredParentLineTotal
      }));
    }

    const comparisonMilli = children.length > 0
      ? children.reduce((sum, child) => sum + moneyToMilli(child.company_total), 0n)
      : eligibleLines.reduce((sum, line) => sum + moneyToMilli(line.company_total), 0n);
    const parentTotalMilli = moneyToMilli(parent.company_total);
    const totalsReconcile = comparisonMilli === parentTotalMilli && childLinesReconcile;
    if (!totalsReconcile) {
      groupFailures.push(failure("parent-child-total-mismatch", {
        parentTransferId: parent.transfer_id,
        parentCompanyTotal: parent.company_total,
        comparisonTotal: milliToMoney(comparisonMilli)
      }));
    }

    const mappedLines = eligibleLines.map((line) => {
      let representedByTransferId = null;
      if (children.length === 0 && line.company_id === parent.company_id && parentInvoices.length === 1) {
        representedByTransferId = parent.transfer_id;
      } else {
        const child = childByCompany.get(line.company_id);
        if (child) representedByTransferId = child.transfer_id;
      }
      return mapLine(line, representedByTransferId);
    });
    const representedLines = mappedLines.filter((line) => line.representedByTransferId !== null);
    const representedRefs = new Set(representedLines.map((line) => line.payableLineRef));
    const exactlyOnce = representedLines.length === eligibleLines.length
      && representedRefs.size === eligibleLines.length;
    if (!exactlyOnce) {
      groupFailures.push(failure("eligible-lines-not-exactly-once", { parentTransferId: parent.transfer_id }));
    }

    const requiredInvoiceTransfers = new Set(children.length > 0
      ? children.map((child) => child.transfer_id)
      : [parent.transfer_id]);
    for (const transferId of requiredInvoiceTransfers) {
      const active = (invoiceRowsByTransfer.get(transferId) ?? []).filter((invoice) => invoice.deleted === 0);
      if (active.length !== 1) {
        groupFailures.push(failure("missing-single-active-invoice", {
          parentTransferId: parent.transfer_id,
          recordType: "transfer",
          recordId: transferId
        }));
      }
    }

    const groupTransferIds = new Set([parent.transfer_id, ...childTransferIds]);
    const groupInvoices = fixture.invoices.filter((invoice) => groupTransferIds.has(invoice.transfer_id));
    const documents = mapDocuments(groupInvoices, transferIndex, childTransferIds);
    const importable = groupFailures.length === 0;
    const importedLines = mappedLines.map(({ representedByTransferId, ...line }) => ({ ...line, representedByTransferId }));
    const parentOwnTotal = parentOwn.reduce((sum, line) => sum + moneyToMilli(line.company_total), 0n);

    groups.push({
      parentTransferId: parent.transfer_id,
      parentCompanyId: parent.company_id,
      legacyGroupId: `LEGACY-TRANSFER-${parent.transfer_id}`,
      parentOwnLines: {
        count: parentOwn.length,
        companyTotal: milliToMoney(parentOwnTotal),
        outcome: parentOutcome,
        evidenceInvoiceNumbers: parentInvoices.map((invoice) => legacyInvoiceNumber(invoice.invoice_id))
      },
      reconciliation: {
        basis: children.length > 0 ? "child-transfer-company-totals" : "parent-line-company-totals",
        parentCompanyTotal: parent.company_total,
        comparisonTotal: milliToMoney(comparisonMilli),
        reconciles: totalsReconcile,
        children: childReconciliation
      },
      assertions: {
        everyEligibleLineExactlyOnce: exactlyOnce,
        parentAndChildTotalsWithoutDoubleCount: totalsReconcile && exactlyOnce,
        childLinesFilteredFromParentByCompany: mappedLines.every((line) => {
          if (line.representedByTransferId === parent.transfer_id) return true;
          const child = transferIndex.get(line.representedByTransferId);
          return child?.parent_transfer_id === parent.transfer_id && child.company_id === line.orgId;
        }),
        companyAndStoreProvenancePreserved: mappedLines.every((line) =>
          isPositiveId(line.orgId) && isPositiveId(line.storeId))
      },
      importable,
      importPlan: importable ? {
        invoiceGroup: {
          legacyGroupId: `LEGACY-TRANSFER-${parent.transfer_id}`,
          sourceParentTransferId: parent.transfer_id
        },
        lines: importedLines,
        documents
      } : null,
      failures: sortFailures(groupFailures)
    });
    failures.push(...groupFailures);
  }

  const summary = groups.reduce((result, billingGroup) => {
    const eligible = fixture.transfer_candidates.filter((line) => line.transfer_id === billingGroup.parentTransferId).length;
    const represented = billingGroup.importPlan?.lines.length
      ?? eligible - (billingGroup.failures.some((candidate) => candidate.code === "eligible-lines-not-exactly-once")
        ? billingGroup.parentOwnLines.count
        : 0);
    result.eligibleLineCount += eligible;
    result.representedLineCount += represented;
    result.importableGroupCount += billingGroup.importable ? 1 : 0;
    result.blockedGroupCount += billingGroup.importable ? 0 : 1;
    return result;
  }, {
    rootTransferCount: groups.length,
    eligibleLineCount: 0,
    representedLineCount: 0,
    importableGroupCount: 0,
    blockedGroupCount: 0,
    failureCount: 0
  });
  summary.failureCount = failures.length;

  return {
    schemaVersion: 1,
    fixtureId: fixture.fixtureId,
    sourceKind: fixture.sourceKind,
    mode: "read-only",
    rootSelection: {
      predicate: "parent_transfer_id IS NULL",
      transferIds: rootTransferIds
    },
    status: failures.length === 0 ? "ready" : "blocked",
    assertions: {
      legacyNamespaceDisjoint: !newInvoiceNumbers.some((number) => number.startsWith(LEGACY_PREFIX))
    },
    groups,
    failures: sortFailures(failures),
    summary
  };
}

export async function reconcileBillingFixtureFile(path) {
  const body = await readFile(path, "utf8");
  return reconcileBillingFixture(JSON.parse(body));
}

async function main() {
  if (process.argv.length !== 3) {
    process.stderr.write("usage: billing-import-reconcile.mjs FIXTURE.json\n");
    process.exitCode = 64;
    return;
  }
  try {
    const report = await reconcileBillingFixtureFile(resolve(process.argv[2]));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === "ready" ? 0 : 2;
  } catch (error) {
    const report = {
      schemaVersion: 1,
      mode: "read-only",
      status: "blocked",
      failures: [{ code: "fixture-read-failed", detail: error instanceof Error ? error.message : String(error) }]
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
