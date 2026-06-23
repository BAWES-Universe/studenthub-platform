import { notFound } from "next/navigation";
import { requireRoleCapability } from "@/modules/auth/session";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { formatDate } from "@/modules/workspace/format";
import { getDegreeGroup } from "@/modules/admin/degree-group/actions";
import { DegreeGroupDetailForm } from "./DegreeGroupDetailForm";

export const dynamic = "force-dynamic";

export default async function AdminDegreeGroupDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleCapability("admin", "admin.system");
  const { id } = await params;

  const group = await getDegreeGroup(id);
  if (!group) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Degree Groups"
      title={group.degree_group_name_en}
      metrics={[
        { label: "Degrees", value: group.degree_count ?? 0, note: "Degrees in this group" },
        { label: "Sort", value: group.degree_group_sort_order ?? "—", note: "Display order" },
      ]}
    >
      <DegreeGroupDetailForm group={group} />
    </WorkspaceShell>
  );
}
