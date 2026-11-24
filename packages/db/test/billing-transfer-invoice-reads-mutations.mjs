import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Invoices lane, transfer invoice reads (I3), statements (F4.8) and company transfers (O-13): every read guard must be load-bearing. Each mutant
// rewrites one built module or the migration, the named test must fail by
// assertion, and the file is restored before the next. PostgreSQL is required.
assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for transfer invoice read mutations (scratch PostgreSQL)");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const postgres = "dist/packages/db/test/postgres-billing-transfer-invoice-reads.test.js";
const transfers = "dist/packages/db/test/postgres-billing-company-transfers.test.js";
const reads = "packages/db/dist/billing/postgres-transfer-invoice-reads.js";
const decision = "dist/packages/billing/src/transfer-invoice-access.js";
const mutations = [
  ["let recruiters read invoices", "TRANSFER_INVOICE_READS_REFUSED", decision,
    'Object.freeze(["org-owner", "finance"])', 'Object.freeze(["org-owner", "finance", "recruiter"])'],
  ["let operator-level finance read company invoices", "TRANSFER_INVOICE_READS_REFUSED", decision,
    "&& !operators.includes(row.org_id)", ""],
  ["bill an operator organization", "TRANSFER_INVOICE_READS_REFUSED", decision,
    "transferInvoiceReadDecision(rows, orgId, ancestors, operators) {\n    if (operators.includes(orgId))\n        return false;", "transferInvoiceReadDecision(rows, orgId, ancestors, operators) {"],
  ["treat a self grant as subtree", "TRANSFER_INVOICE_READS_SCOPE", decision,
    '(row.scope === "subtree" && ancestors.includes(row.org_id));', "ancestors.includes(row.org_id);"],
  ["read a deleted company", "TRANSFER_INVOICE_READS_REFUSED", reads,
    "if (!await organizationLive(this.#pool, orgId))\n            return null;", ""],
  ["show voided invoices", "TRANSFER_INVOICE_READS_DOCUMENT", reads,
    "WHERE (NOT i.deleted OR i.void_reason = 'credited') AND", "WHERE"],
  ["show every company's invoices", "TRANSFER_INVOICE_READS_TREE", reads,
    "WHERE (NOT i.deleted OR i.void_reason = 'credited') AND i.org_id = ANY($1::text[])", "WHERE (NOT i.deleted OR i.void_reason = 'credited') AND $1::text[] IS NOT NULL"],
  ["let the parent's answer cover its sub-companies", "TRANSFER_INVOICE_READS_SCOPE", reads,
    "node.id === orgId || this.#decision(", "true || this.#decision("],
  ["show unpaid invoices of unlocked or cancelled transfers", "TRANSFER_INVOICE_READS_PAYABLE", reads,
    "\n    AND (i.status = 'paid' OR t.status IN ('locked', 'payment_sent') OR i.void_reason = 'credited')", ""],
  ["hide paid receipts of settled transfers", "TRANSFER_INVOICE_READS_PAYABLE", reads,
    "(i.status = 'paid' OR t.status IN", "(t.status IN"],
  ["skip the read check on the asked organization", "TRANSFER_INVOICE_READS_REFUSED", reads,
    "if (!this.#decision(grants.rows, orgId, above))\n            return null;", ""],
  ["date a payment on its invoice's issue day", "TRANSFER_STATEMENT_FIGURES", reads,
    "THEN (i.paid_at AT TIME ZONE 'Asia/Kuwait')::date END", "THEN i.invoice_date END"],
  ["leave earlier movements out of the opening balance", "TRANSFER_STATEMENT_FIGURES", reads,
    "FROM moves WHERE on_date < $2::date GROUP BY", "FROM moves WHERE on_date < $2::date AND false GROUP BY"],
  ["count payments as invoiced", "TRANSFER_STATEMENT_FIGURES", reads,
    'if (row.kind === "invoice")', "if (true)"],
  ["add payments to the closing balance", "TRANSFER_STATEMENT_FIGURES", reads,
    "const closing = m.opening + m.invoiced - m.paid - m.credited;", "const closing = m.opening + m.invoiced + m.paid - m.credited;"],
  ["list movements after the period", "TRANSFER_STATEMENT_STABLE", reads,
    "FROM moves WHERE on_date BETWEEN $2::date AND $3::date", "FROM moves WHERE on_date >= $2::date AND $3::date IS NOT NULL"],
  ["carry amounts through floating point", "TRANSFER_STATEMENT_PRECISION", reads,
    "abs(amount)::text, on_date", "abs(amount)::float8::numeric(40,3)::text, on_date"],
  ["subtotal every company in the tree", "TRANSFER_STATEMENT_SCOPE", reads,
    "WHERE (NOT i.deleted OR i.void_reason = 'credited') AND i.org_id = ANY($1::text[])", "WHERE (NOT i.deleted OR i.void_reason = 'credited') AND i.org_id IN (SELECT id FROM organizations WHERE id = ANY($1::text[]) OR parent_org_id = ANY($1::text[]))"],
  ["list deleted transfers", "COMPANY_TRANSFERS_LIST", reads,
    "WHERE NOT t.deleted AND t.company_id", "WHERE t.company_id"],
  ["list every company's transfers", "COMPANY_TRANSFERS_REFUSED", reads,
    "AND t.company_id = ANY($1::text[])", "AND $1::text[] IS NOT NULL"],
  ["charge the company the candidates' totals", "COMPANY_TRANSFERS_LIST", reads,
    "COALESCE(sum(l.company_total), 0)", "COALESCE(sum(l.candidate_total), 0)"],
  ["show the company the candidate's side of the calculation", "COMPANY_TRANSFERS_DETAIL", reads,
    "worked: worked && { hours: worked.hours, minutes: worked.minutes }", "worked"],
  ["show the line's account name over the profile name", "COMPANY_TRANSFERS_DETAIL", reads,
    "COALESCE(NULLIF(btrim(pp.display_name), ''), NULLIF(btrim(pr.display_name), ''), l.person_id)", "COALESCE(NULLIF(btrim(pr.display_name), ''), l.person_id)"],
];

const suites = [postgres, transfers];
function run(files, pattern) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1",
    ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), ...files],
  { cwd: root, env: process.env, encoding: "utf8", timeout: 120_000 });
  return { ...result, output: result.stdout + result.stderr };
}
function green(label) {
  const result = run(suites);
  assert.equal(result.error, undefined, `${label}: runner error`);
  assert.equal(result.status, 0, `${label} must pass\n${result.output}`);
  assert.match(result.output, /# skipped 0\b/);
  console.log(`${label}: suite green`);
}
green("baseline");
let killed = 0;
for (const [name, title, path, from, to] of mutations) {
  const target = `${root}${path}`;
  const original = readFileSync(target, "utf8");
  assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
  try {
    writeFileSync(target, original.replace(from, to));
    const result = run(suites, title);
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name}: survived\n${result.output}`);
    assert.match(result.output, new RegExp(`not ok \\d+ - ${title} `), `${name}: named test did not fail\n${result.output}`);
    assert.doesNotMatch(result.output, /SyntaxError|ERR_MODULE_NOT_FOUND|hookFailed|ECONNREFUSED/, `${name}: infrastructure failure\n${result.output}`);
    assert.match(result.output, /code: 'ERR_ASSERTION'/, `${name}: must fail by assertion\n${result.output}`);
    killed++;
    console.log(`KILLED ${name} -> ${title}`);
  } finally { writeFileSync(target, original); }
}
green("restored");
console.log(`${killed}/${mutations.length} transfer invoice read mutations killed`);
