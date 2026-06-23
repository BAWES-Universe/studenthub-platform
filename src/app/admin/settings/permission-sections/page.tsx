import type { Route } from "next";
import { requireRoleCapability } from "@/modules/auth/session";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { listPermissionSections } from "./actions";
import type { PermissionSectionResult } from "@/modules/admin/permission-sections/actions";

export const dynamic = "force-dynamic";

export default async function AdminPermissionSectionsPage() {
  const session = await requireRoleCapability("admin", "admin.system");
  const result = await listPermissionSections();

  const rows: (PermissionSectionResult & { id: string })[] = Array.isArray(result)
    ? result.map((r) => ({ ...r, id: r.permissionUuid }))
    : [];

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin"
      title="Permission Sections"
      metrics={[]}
    >
      <DataTable
        title="Permission Sections"
        description="Manage permission section groupings"
        rows={rows}
        rowHref={(row) =>
          `/admin/settings/permission-sections/${row.permissionUuid}` as Route
        }
        columns={[
          { key: "sectionName", label: "Section Name", render: (row) => <strong>{row.sectionName ?? "—"}</strong> },
          {
            key: "createdAt",
            label: "Created",
            render: (row) =>
              new Intl.DateTimeFormat("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              }).format(row.createdAt),
          },
        ]}
      />
    </WorkspaceShell>
  );
}
