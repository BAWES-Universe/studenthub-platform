"use client";

import React from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────

export interface ComparisonRow {
  category: string;
  feature: string;
  studenthub: boolean | string;
  alternatives: boolean | string;
  emailSpreadsheets: boolean | string;
  traditionalAgencies: boolean | string;
}

export interface ComparisonTableProps {
  persona?: "candidate" | "company";
  className?: string;
}

// ── Column labels ────────────────────────────────────────

interface ColumnDef {
  key: "studenthub" | "alternatives" | "emailSpreadsheets" | "traditionalAgencies";
  label: string;
  accent?: boolean;
}

const sharedColumns: ColumnDef[] = [
  { key: "studenthub", label: "StudentHub", accent: true },
  { key: "alternatives", label: "Job boards" },
  { key: "emailSpreadsheets", label: "Email & sheets" },
  { key: "traditionalAgencies", label: "Agencies" },
];

// ── Data ─────────────────────────────────────────────────

const candidateRows: ComparisonRow[] = [
  { category: "Profile", feature: "Unified profile visible to all employers", studenthub: true, alternatives: "Partial", emailSpreadsheets: false, traditionalAgencies: false },
  { category: "Profile", feature: "Profile readiness score", studenthub: true, alternatives: false, emailSpreadsheets: false, traditionalAgencies: false },
  { category: "Search", feature: "Typo-tolerant search", studenthub: true, alternatives: false, emailSpreadsheets: false, traditionalAgencies: false },
  { category: "Search", feature: "Filter by location, skill, pay", studenthub: true, alternatives: "Partial", emailSpreadsheets: false, traditionalAgencies: "Partial" },
  { category: "Matching", feature: "Staff-matched role suggestions", studenthub: true, alternatives: "Partial", emailSpreadsheets: false, traditionalAgencies: false },
  { category: "Matching", feature: "Real-time application tracking", studenthub: true, alternatives: false, emailSpreadsheets: false, traditionalAgencies: false },
  { category: "Payments", feature: "Integrated timesheets", studenthub: true, alternatives: false, emailSpreadsheets: false, traditionalAgencies: "Partial" },
  { category: "Payments", feature: "Direct payment tracking", studenthub: true, alternatives: false, emailSpreadsheets: false, traditionalAgencies: "Partial" },
  { category: "Documents", feature: "Digital document management", studenthub: true, alternatives: "Partial", emailSpreadsheets: false, traditionalAgencies: "Partial" },
  { category: "Documents", feature: "Compliance tracking", studenthub: true, alternatives: false, emailSpreadsheets: false, traditionalAgencies: "Partial" },
];

const companyRows: ComparisonRow[] = [
  { category: "Sourcing", feature: "Staff-matched candidates", studenthub: true, alternatives: "Partial", emailSpreadsheets: false, traditionalAgencies: "Partial" },
  { category: "Sourcing", feature: "Post to multiple branches", studenthub: true, alternatives: false, emailSpreadsheets: false, traditionalAgencies: "Partial" },
  { category: "Compliance", feature: "Right-to-work verification", studenthub: true, alternatives: false, emailSpreadsheets: false, traditionalAgencies: "Partial" },
  { category: "Compliance", feature: "Certification tracking", studenthub: true, alternatives: false, emailSpreadsheets: false, traditionalAgencies: false },
  { category: "Timesheets", feature: "Digital clock-in/out", studenthub: true, alternatives: "Partial", emailSpreadsheets: false, traditionalAgencies: false },
  { category: "Timesheets", feature: "Bulk approval workflow", studenthub: true, alternatives: false, emailSpreadsheets: false, traditionalAgencies: "Partial" },
  { category: "Billing", feature: "Consolidated per-branch invoices", studenthub: true, alternatives: false, emailSpreadsheets: false, traditionalAgencies: "Partial" },
  { category: "Billing", feature: "Automated VAT", studenthub: true, alternatives: false, emailSpreadsheets: false, traditionalAgencies: false },
  { category: "Analytics", feature: "Time-to-hire dashboard", studenthub: true, alternatives: "Partial", emailSpreadsheets: false, traditionalAgencies: false },
  { category: "Analytics", feature: "Cost-per-hire tracking", studenthub: true, alternatives: false, emailSpreadsheets: false, traditionalAgencies: false },
];

const personaRows: Record<string, ComparisonRow[]> = {
  candidate: candidateRows,
  company: companyRows,
};

// ── Score helpers ────────────────────────────────────────

type ScoreValue = boolean | string;

function getScore(value: ScoreValue): "full" | "partial" | "none" {
  if (value === true) return "full";
  if (value === false) return "none";
  if (value === "Partial" || value === "Limited") return "partial";
  return "none";
}

function ScoreDot({ value }: { value: ScoreValue }) {
  const score = getScore(value);
  const cls = score === "full" ? "inline-flex size-2.5 rounded-full bg-green-500"
    : score === "partial" ? "inline-flex size-2.5 rounded-full bg-amber-400"
    : "inline-flex size-2.5 rounded-full bg-muted-foreground/30";
  return <span className={cls} />;
}

// ── Component ────────────────────────────────────────────

export default function ComparisonTable({ persona = "candidate", className }: ComparisonTableProps) {
  const rows = personaRows[persona] ?? candidateRows;
  const columns = sharedColumns;
  const totalFeatures = rows.length;
  const shFullScore = rows.filter((r) => getScore(r.studenthub) === "full").length;

  // Group by category
  const categories = rows.reduce<{ category: string; rows: ComparisonRow[] }[]>((acc, row) => {
    const existing = acc.find((c) => c.category === row.category);
    if (existing) existing.rows.push(row);
    else acc.push({ category: row.category, rows: [row] });
    return acc;
  }, []);

  return (
    <section
      className={cn("scroll-mt-20", className)}
      aria-label="Feature comparison"
    >
      <div className="text-center mb-8 md:mb-10">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold tracking-wide text-[#1f73b7] bg-[#1f73b7]/10">
          <Sparkles className="size-3" />
          See the difference
        </span>
        <h2 className="text-[clamp(24px,3.5vw,36px)] font-bold leading-[1.15] tracking-[-0.02em] text-foreground mt-3">
          {persona === "candidate"
            ? "Why students choose StudentHub."
            : "Why companies choose StudentHub."}
        </h2>
        <p className="text-sm leading-relaxed max-w-[600px] mx-auto text-muted-foreground mt-2">
          {persona === "candidate"
            ? "StudentHub gives you tools that job boards and agencies can't match."
            : "One platform replaces four legacy tools."}
        </p>
      </div>

      {/* Score summary */}
      <div className="max-w-[600px] mx-auto mb-6">
        <div className="rounded-xl p-4 flex items-center justify-center gap-3 bg-gradient-to-br from-[#1f73b7]/5 to-[#1f73b7]/2 border border-[#1f73b7]/15">
          <span className="inline-flex size-2.5 rounded-full bg-green-500" />
          <span className="text-sm font-semibold text-foreground">
            StudentHub scores{" "}
            <span className="text-[#1f73b7]">
              {shFullScore}/{totalFeatures}
            </span>{" "}
            features — more than any alternative.
          </span>
        </div>
      </div>

      {/* Desktop: solid table */}
      <div className="hidden md:block overflow-x-auto rounded-xl bg-card border border-border shadow-sm">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="text-left p-3 text-xs font-semibold text-muted-foreground bg-card border-b border-border min-w-[200px]">
                Feature
              </th>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "text-center p-3 text-xs font-semibold border-b border-border min-w-[120px]",
                    col.accent ? "text-[#1f73b7] bg-[#1f73b7]/5" : "text-muted-foreground bg-card"
                  )}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((cat) => (
              <React.Fragment key={cat.category}>
                {/* Category header row */}
                <tr>
                  <td
                    colSpan={5}
                    className="text-[10px] font-bold uppercase tracking-wider p-2 px-3 text-[#1f73b7] bg-[#1f73b7]/3 border-b border-border"
                  >
                    {cat.category}
                  </td>
                </tr>
                {cat.rows.map((row, ri) => (
                  <tr
                    key={`${cat.category}-${ri}`}
                    className="transition-colors duration-150"
                    style={{
                      backgroundColor:
                        ri % 2 === 0 ? "var(--card)" : "transparent",
                    }}
                  >
                    <td
                      className="p-3 text-xs text-foreground border-b border-border"
                    >
                      {row.feature}
                    </td>
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={cn(
                          "text-center p-3 border-b border-border",
                          col.accent ? "bg-[#1f73b7]/3" : "bg-transparent"
                        )}
                      >
                        <ScoreDot value={row[col.key]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: accordion list */}
      <div className="md:hidden grid gap-3">
        {categories.map((cat) => (
          <div
            key={cat.category}
            className="rounded-xl overflow-hidden bg-card border border-border shadow-sm"
          >
            <div
              className="p-3 text-[11px] font-bold uppercase tracking-wider text-[#1f73b7] bg-[#1f73b7]/5 border-b border-border"
            >
              {cat.category}
            </div>
            {cat.rows.map((row, ri) => (
              <div
                key={`${cat.category}-${ri}`}
                className="p-3"
                style={{
                  borderBottom:
                    ri < cat.rows.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                <strong className="text-sm block mb-2 text-foreground">
                  {row.feature}
                </strong>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {columns.map((col) => (
                    <div
                      key={col.key}
                      className="flex items-center justify-between gap-2"
                    >
                      <span
                        className={cn(
                          "font-medium",
                          col.accent ? "text-[#1f73b7]" : "text-muted-foreground"
                        )}
                      >
                        {col.label}
                      </span>
                      <ScoreDot value={row[col.key]} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="text-center mt-6">
        <p className="text-[10px] text-muted-foreground">
          Based on {totalFeatures} features compared.
        </p>
      </div>
    </section>
  );
}
