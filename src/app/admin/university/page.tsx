import type { Route } from "next";
import { requireRoleCapability } from "@/modules/auth/session";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { formatDate } from "@/modules/workspace/format";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type UniversityRow = {
  id: number;
  name_en: string;
  name_ar: string;
  data_source: number;
  candidates: number;
  updated: string;
};

export default async function AdminUniversityPage() {
  const session = await requireRoleCapability("admin", "admin.system");

  const rows = await prisma.university.findMany({
    where: { deleted: 0 },
    orderBy: { university_name_en: "asc" },
    take: 100,
    select: {
      university_id: true,
      university_name_en: true,
      university_name_ar: true,
      university_data_source: true,
      university_updated_at: true,
      _count: { select: { candidate: true } },
    },
  });

  const mapped: UniversityRow[] = rows.map((r) => ({
    id: r.university_id,
    name_en: r.university_name_en ?? "—",
    name_ar: r.university_name_ar ?? "—",
    data_source: r.university_data_source ?? 0,
    candidates: r._count.candidate,
    updated: formatDate(r.university_updated_at),
  }));

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin"
      title="Universities"
      metrics={[{ label: "Universities", value: mapped.length, note: "Active universities" }]}
    >
      <DataTable
        title="Universities"
        description="Manage university records used in candidate profiles and education"
        rows={mapped}
        rowHref={(row) => `/admin/university/${row.id}` as Route}
        columns={[
          { key: "name_en", label: "Name (EN)", render: (row) => <strong>{row.name_en}</strong> },
          { key: "name_ar", label: "Name (AR)", render: (row) => row.name_ar },
          { key: "data_source", label: "Source", render: (row) => row.data_source },
          { key: "candidates", label: "Candidates", render: (row) => row.candidates },
          { key: "updated", label: "Updated", render: (row) => row.updated },
        ]}
      />
    </WorkspaceShell>
  );
}
