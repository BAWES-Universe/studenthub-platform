import type { Route } from "next";
import { requireRoleCapability } from "@/modules/auth/session";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { listMajors } from "@/modules/admin/major/actions";

export const dynamic = "force-dynamic";

export default async function AdminMajorPage() {
  const session = await requireRoleCapability("admin", "admin.system");

  const { records, total } = await listMajors({ page: 1, limit: 100 });

  const rows = records.map((r) => ({
    id: r.major_uuid,
    name_en: r.major_name_en,
    name_ar: r.major_name_ar,
    candidate_count: r.candidate_count,
    data_source: r.data_source,
  }));

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin"
      title="Majors"
      metrics={[{ label: "Majors", value: total, note: "Active major fields of study" }]}
    >
      <DataTable
        title="Majors"
        description="Manage major fields of study used in candidate education records"
        rows={rows}
        rowHref={(row) => `/admin/major/${row.id}` as Route}
        columns={[
          { key: "name_en", label: "Name (EN)", render: (row) => <strong>{row.name_en}</strong> },
          { key: "name_ar", label: "Name (AR)", render: (row) => row.name_ar },
          { key: "candidate_count", label: "Candidates", render: (row) => row.candidate_count },
          { key: "data_source", label: "Source", render: (row) => row.data_source ?? "—" },
        ]}
      />
    </WorkspaceShell>
  );
}
