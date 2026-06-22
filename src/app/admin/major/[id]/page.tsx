import { notFound } from "next/navigation";
import { requireRoleCapability } from "@/modules/auth/session";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { formatDate } from "@/modules/workspace/format";
import { getMajor } from "@/modules/admin/major/actions";
import { MajorDetailForm } from "./MajorDetailForm";

export const dynamic = "force-dynamic";

export default async function AdminMajorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleCapability("admin", "admin.system");
  const { id } = await params;

  const major = await getMajor(id);
  if (!major) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Majors"
      title={major.major_name_en}
      metrics={[
        { label: "Candidates", value: major.candidate_count ?? 0, note: "Education records with this major" },
        { label: "Created", value: major.major_created_at ? formatDate(new Date(major.major_created_at)) : "—", note: "Record created" },
      ]}
    >
      <MajorDetailForm major={major} />
    </WorkspaceShell>
  );
}
