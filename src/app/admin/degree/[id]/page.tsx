import { notFound } from "next/navigation";
import { requireRoleCapability } from "@/modules/auth/session";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { formatDate } from "@/modules/workspace/format";
import { getDegreeDetail, getDegreeGroupOptions } from "../actions";
import { DegreeDetailForm } from "./DegreeDetailForm";

export const dynamic = "force-dynamic";

export default async function AdminDegreeDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleCapability("admin", "admin.system");
  const { id } = await params;

  const degree = await getDegreeDetail(id);
  if (!degree) {
    notFound();
  }

  const groups = await getDegreeGroupOptions();

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Degree"
      title={degree.degree_name_en}
      metrics={[
        { label: "Created", value: formatDate(degree.degree_created_at), note: "Record created" },
        { label: "Updated", value: formatDate(degree.degree_updated_at), note: "Last modified" }
      ]}
    >
      <DegreeDetailForm degree={degree} groups={groups} />
    </WorkspaceShell>
  );
}
