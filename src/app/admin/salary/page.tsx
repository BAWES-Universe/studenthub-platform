import type { Route } from "next";
import { requireRoleCapability } from "@/modules/auth/session";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { getAdminSalaryRows } from "@/modules/workspace/data";

export const dynamic = "force-dynamic";

export default async function AdminSalaryPage() {
  const session = await requireRoleCapability("admin", "admin.system");
  const rows = await getAdminSalaryRows();

  return (
    <WorkspaceShell session={session} eyebrow="Admin" title="Salary Records" metrics={[]}>
      <DataTable
        title="Salary Records"
        description="View staff salary records across the platform"
        rows={rows}
        rowHref={(row) => `/admin/salary/${row.id}` as Route}
        columns={[
          { key: "staff", label: "Staff", render: (row) => <strong>{row.staff}</strong> },
          { key: "salary", label: "Salary", render: (row) => `${row.salary.toFixed(3)} ${row.currency}` },
          { key: "comment", label: "Comment", render: (row) => row.comment },
          { key: "salary_date", label: "Salary Date", render: (row) => row.salary_date },
          { key: "updated", label: "Updated", render: (row) => row.updated },
        ]}
      />
    </WorkspaceShell>
  );
}
