import type { Route } from "next";
import { requireRoleCapability } from "@/modules/auth/session";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { getSettingsList } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const session = await requireRoleCapability("admin", "admin.system");
  const rows = await getSettingsList();

  return (
    <WorkspaceShell session={session} eyebrow="Admin" title="Settings" metrics={[]}>
      <DataTable
        title="Settings"
        description="Manage platform settings and configuration values"
        rows={rows}
        rowHref={(row) => `/admin/settings/${row.setting_uuid}` as Route}
        columns={[
          { key: "code", label: "Code", render: (row) => <strong>{row.code}</strong> },
          { key: "key", label: "Key", render: (row) => row.key },
          { key: "value", label: "Value", render: (row) => {
            const val = row.value ?? "";
            return val.length > 60 ? `${val.slice(0, 60)}...` : val;
          }},
          { key: "serialized", label: "Serialized", render: (row) => row.serialized ? "Yes" : "No" },
          { key: "updated", label: "Updated", render: (row) =>
            row.updated_at
              ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(row.updated_at)
              : "—"
          }
        ]}
      />
    </WorkspaceShell>
  );
}
