import { notFound } from "next/navigation";
import { requireRoleCapability } from "@/modules/auth/session";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { formatDate } from "@/modules/workspace/format";
import { prisma } from "@/lib/prisma";
import { UniversityDetailForm } from "./UniversityDetailForm";

export const dynamic = "force-dynamic";

export default async function AdminUniversityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleCapability("admin", "admin.system");
  const { id } = await params;
  const universityId = Number(id);

  if (Number.isNaN(universityId) || universityId < 1) {
    notFound();
  }

  const record = await prisma.university.findFirst({
    where: { university_id: universityId, deleted: 0 },
    include: {
      _count: { select: { candidate: true } },
    },
  });

  if (!record) {
    notFound();
  }

  const university = {
    university_id: record.university_id,
    university_name_en: record.university_name_en ?? null,
    university_name_ar: record.university_name_ar ?? null,
    university_data_source: record.university_data_source ?? null,
    candidate_count: record._count.candidate,
  };

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Universities"
      title={university.university_name_en ?? `University #${university.university_id}`}
      metrics={[
        { label: "Candidates", value: university.candidate_count, note: "Candidates from this university" },
        { label: "Source", value: university.university_data_source ?? "—", note: "Data source ID" },
      ]}
    >
      <UniversityDetailForm university={university} />
    </WorkspaceShell>
  );
}
