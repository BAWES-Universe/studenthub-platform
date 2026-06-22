import type { Route } from "next";
import { requireRoleCapability } from "@/modules/auth/session";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { formatDate } from "@/modules/workspace/format";
import { listFulltimers } from "@/modules/admin/fulltimer/actions";

export const dynamic = "force-dynamic";

export default async function AdminFulltimerPage() {
  const session = await requireRoleCapability("admin", "admin.system");
  const { records } = await listFulltimers({ limit: 200 });

  return (
    <WorkspaceShell session={session} eyebrow="Admin" title="Full-Time Registrations" metrics={[
      { label: "Total", value: records.length, note: "Registered full-timers" },
    ]}>
      <DataTable
        title="Full-Timers"
        description="Manage full-time registration records"
        rows={records.map((r) => ({ ...r, id: r.fulltimer_uuid }))}
        rowHref={(row) => `/admin/fulltimer/${row.fulltimer_uuid}` as Route}
        columns={[
          { key: "name", label: "Name", render: (row) => <strong>{row.fulltimer_name}</strong> },
          { key: "email", label: "Email", render: (row) => row.fulltimer_email },
          { key: "phone", label: "Phone", render: (row) => row.fulltimer_phone ?? "—" },
          { key: "country", label: "Country", render: (row) => row.country_name ?? "—" },
          { key: "nationality", label: "Nationality", render: (row) => row.nationality_name ?? "—" },
          { key: "employed", label: "Employed", render: (row) => row.fulltimer_employed === true ? "Yes" : row.fulltimer_employed === false ? "No" : "—" },
          { key: "created", label: "Registered", render: (row) => formatDate(row.fulltimer_created_datetime) },
        ]}
      />
    </WorkspaceShell>
  );
}
