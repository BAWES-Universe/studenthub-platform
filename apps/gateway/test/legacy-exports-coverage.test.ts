import assert from "node:assert/strict";
import test from "node:test";
import { EXPORT_HTTP_KINDS } from "../src/exports-http.js";

/**
 * Contract P-1, reports lane slice 7: every legacy file download (the audit in the project's
 * `contracts/exports-audit.md`, legacy `BAWES-Universe/studenthub` @ 55119d3) is either served by
 * an export kind the gateway offers, still owed by a named lane, or dropped with the evidence.
 * When a lane registers a kind for a pending download, this test fails until the row below
 * names that kind, so the audit cannot drift from main.
 */
type Coverage = { readonly kind: string } | { readonly owedBy: string } | { readonly dropped: string };
const LEGACY_DOWNLOADS: Readonly<Record<string, Coverage>> = {
  // 1. Admin directory lists.
  "admin company/download-list-excel": { kind: "company-directory" },
  "admin country/download-list-excel": { kind: "catalogue-country" },
  "admin university/download-list-excel": { kind: "catalogue-university" },
  // 2. Staff work sessions.
  "admin staff-work-session/download-list-excel": { kind: "work-staff-sessions" },
  // 3. Company money per candidate: reports P-4 once transfers land.
  "admin company/download-candidates-excel": { owedBy: "reports lane P-4, after the pay lane's transfers" },
  // 4. Bank and payment files.
  "admin transfer/export-payable-candidates": { owedBy: "pay lane" },
  "admin transfer/download-payment-advice-for-abk": { owedBy: "pay lane" },
  "admin transfer/download-text-payment-advice-for-abk": { owedBy: "pay lane" },
  "admin transfer/export-google-excel": { owedBy: "pay lane" },
  "cron payable-candidate-notification": { owedBy: "pay lane (the email sends a P-1 link, not the file)" },
  // 5. Transfer reports.
  "staff transfer/export-candidate-transfers": { owedBy: "pay lane or reports P-4" },
  "staff transfer/export-companies-transfer": { owedBy: "pay lane or reports P-4" },
  // 6. Transfer upload template (staff and company).
  "staff, company transfer/transfer-excel-template": { owedBy: "pay lane" },
  // 7. Company work logs.
  "company candidate/work-log-detailed-excel": { kind: "work-log-detailed" },
  "company candidate/work-log-excel": { kind: "work-log-summary" },
  // Outside the seven families.
  "staff candidate/export-assigned-history": { kind: "work-assigned-history" },
  "staff candidate/export-candidate-data": { dropped: "no caller in any legacy frontend (10-27 rule: not something a user can do today)" },
};

test("REPORTS_EXPORTS_COVERAGE every legacy download is served by a registered kind, owed by a lane, or dropped with evidence", () => {
  assert.equal(Object.keys(LEGACY_DOWNLOADS).length, 17, "the audit counted 17 legacy downloads");
  const named = Object.values(LEGACY_DOWNLOADS).flatMap(c => "kind" in c ? [c.kind] : []);
  for (const [download, coverage] of Object.entries(LEGACY_DOWNLOADS)) {
    if ("kind" in coverage) assert.ok(EXPORT_HTTP_KINDS.has(coverage.kind), `${download}: ${coverage.kind} is not offered by the gateway`);
    else assert.ok(Object.values(coverage)[0]!.length > 0, download);
  }
  for (const kind of EXPORT_HTTP_KINDS.keys())
    assert.ok(named.includes(kind), `${kind} is offered but no legacy download names it: update LEGACY_DOWNLOADS (and the audit) or say what it replaces`);
  assert.equal(new Set(named).size, named.length, "each kind serves one legacy download");
});
