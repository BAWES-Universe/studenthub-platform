import type { Route } from "next";
import Link from "next/link";
import { requireRoleCapability } from "@/modules/auth/session";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getAdminTransferRows } from "@/modules/workspace/data";

export const dynamic = "force-dynamic";

export default async function AdminTransfersPage() {
  const session = await requireRoleCapability("admin", "finance.read");
  const rows = await getAdminTransferRows();
  const latest = rows[0];

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin finance"
      title="Pay candidates and invoice companies from transfer runs."
      metrics={[
        { label: "Runs shown", value: rows.length, note: "Latest imported transfer batches" },
        { label: "Latest run", value: latest ? `#${latest.id}` : "None", note: latest?.company ?? "No transfer rows found" },
        { label: "Invoice source", value: "Transfers", note: "Candidate payouts and employer totals live here" },
        { label: "Next action", value: "Review", note: "Open a run before exporting PDFs or reconciling pay" }
      ]}
    >
      <Card className="mb-6" aria-label="Finance workflow">
        <CardContent className="grid gap-6 p-5">
          <div className="grid gap-2">
            <span className="text-xs font-bold uppercase tracking-wide text-[#eb6651]">Finance path</span>
            <h2 className="text-xl font-semibold mb-0">
              Start with a transfer run. Everything else should hang off that.
            </h2>
            <p className="text-muted-foreground text-sm max-w-[600px] mb-0">
              A run is the place to inspect candidate payouts, employer charges, period dates, status, invoice context,
              and PDF exports. The table below is only the index.
            </p>
            {latest ? (
              <Link
                href={`/admin/transfers/${latest.id}` as Route}
                className="mt-2"
              >
                <Button variant="default" className="bg-[#1f73b7] hover:bg-[#1a5e96]">
                  Open latest run #{latest.id}
                </Button>
              </Link>
            ) : null}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              ["1", "Review run", "Check company, period, total, and status."],
              ["2", "Check payouts", "Inspect candidate rows before payment."],
              ["3", "Issue invoice", "Generate employer invoice PDF from the same source."],
              ["4", "Reconcile", "Mark what is paid, exported, or needs correction."]
            ].map(([step, title, note]) => (
              <Card key={step} className="border border-border bg-muted/30">
                <CardContent className="p-4 grid gap-1.5">
                  <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-[#1f73b7] text-white text-sm font-bold">
                    {step}
                  </span>
                  <strong className="text-sm font-semibold">{title}</strong>
                  <p className="text-xs text-muted-foreground mb-0">{note}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>
      <DataTable
        title="Transfer Runs"
        description="Open a run to review candidate payouts, employer totals, invoices, and supporting PDF actions."
        rows={rows}
        rowHref={(row) => `/admin/transfers/${row.id}` as Route}
        columns={[
          { key: "id", label: "Transfer", render: (row) => <strong>#{row.id}</strong> },
          { key: "company", label: "Company", render: (row) => row.company },
          { key: "period", label: "Period", render: (row) => row.period },
          { key: "status", label: "Status", render: (row) => row.status },
          { key: "total", label: "Total", render: (row) => row.total }
        ]}
      />
    </WorkspaceShell>
  );
}
