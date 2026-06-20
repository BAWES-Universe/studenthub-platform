import type { Route } from "next";
import Link from "next/link";
import { requireRoleCapability } from "@/modules/auth/session";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { getCompanyRequestRows } from "@/modules/workspace/data";

export const dynamic = "force-dynamic";

const statusVariant: Record<string, "default" | "secondary" | "success" | "warning" | "outline"> = {
  pending: "warning",
  started: "outline",
  delivered: "success",
  cancelled: "outline",
  finished_by_recruitment: "secondary",
};

export default async function CompanyRequestsPage() {
  const session = await requireRoleCapability("company", "request.read.linked");
  const rows = await getCompanyRequestRows(session.id);

  return (
    <WorkspaceShell session={session} eyebrow="Company" title="Requests" metrics={[]}>
      <div className="mb-4">
        <Button variant="default" asChild>
          <Link href="/company/requests/create">
            + New Request
          </Link>
        </Button>
      </div>
      <DataTable
        title="Hiring Requests"
        description="Requests across the company accounts linked to this contact."
        rows={rows}
        rowHref={(row) => `/company/requests/${row.id}` as Route}
        columns={[
          { key: "title", label: "Request", render: (row) => <strong>{row.title}</strong> },
          { key: "company", label: "Company", render: (row) => row.company },
          { key: "owner", label: "Owner", render: (row) => row.owner },
          { key: "seats", label: "Seats", render: (row) => row.seats },
          {
            key: "status",
            label: "Status",
            render: (row) => (
              <Badge variant={statusVariant[row.status as string] ?? "secondary"}>
                {(row.status as string).replace(/_/g, " ")}
              </Badge>
            ),
          },
          { key: "updated", label: "Updated", render: (row) => row.updated }
        ]}
      />
    </WorkspaceShell>
  );
}
