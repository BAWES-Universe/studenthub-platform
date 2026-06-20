import type { Route } from "next";
import { requireRoleCapability } from "@/modules/auth/session";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { getAdminDegreeRows } from "@/modules/workspace/data";

export const dynamic = "force-dynamic";

export default async function AdminDegreePage() {
  const session = await requireRoleCapability("admin", "admin.system");
  const rows = await getAdminDegreeRows();

  return (
    <WorkspaceShell session={session} eyebrow="Admin" title="Degrees" metrics={[]}>
      <DataTable
        title="Degrees"
        description="Manage degree types across the platform"
        rows={rows}
        rowHref={(row) => `/admin/degree/${row.id}` as Route}
        columns={[
          { key: "name_en", label: "Name (EN)", render: (row) => <strong>{row.name_en}</strong> },
          { key: "name_ar", label: "Name (AR)", render: (row) => row.name_ar },
          { key: "group", label: "Group", render: (row) => row.group },
          { key: "sort_order", label: "Sort", render: (row) => row.sort_order },
          { key: "updated", label: "Updated", render: (row) => row.updated }
        ]}
      />
    </WorkspaceShell>
  );
}
