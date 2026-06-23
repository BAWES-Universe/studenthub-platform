import { notFound } from "next/navigation";
import { requireRoleCapability } from "@/modules/auth/session";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { getPermissionSection } from "../actions";
import { PermissionSectionForm } from "./permission-section-form";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function PermissionSectionDetailPage({ params }: Props) {
  const session = await requireRoleCapability("admin", "admin.system");
  const { id } = await params;
  const result = await getPermissionSection(id);

  if (!result || "error" in result) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Permission Sections"
      title={result.sectionName ?? "Permission Section"}
      metrics={[]}
    >
      <PermissionSectionForm section={result} />
    </WorkspaceShell>
  );
}
