import type { Route } from "next";
import { requireRoleCapability } from "@/modules/auth/session";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { getAdminSettingRows } from "@/modules/workspace/data";

export const dynamic = "force-dynamic";

export default async function AdminSettingPage() {
  const session = await requireRoleCapability("admin", "admin.system");
  const rows = await getAdminSettingRows();

  return (
    <WorkspaceShell session={session} eyebrow="Admin" title="Settings" metrics={[]}>
      <DataTable
        title="Settings"
        description="Manage application settings (key-value store)"
        rows={rows}
        rowHref={(row) => `/admin/setting/${row.id}` as Route}
        columns={[
          { key: "code", label: "Code", render: (row) => <strong>{row.code}</strong> },
          { key: "key", label: "Key", render: (row) => row.key },
          { key: "value", label: "Value", render: (row) => <span className="font-mono text-xs">{row.value}</span> },
          { key: "serialized", label: "Serialized", render: (row) => row.serialized },
          { key: "updated", label: "Updated", render: (row) => row.updated }
        ]}
      />
    </WorkspaceShell>
  );
}
