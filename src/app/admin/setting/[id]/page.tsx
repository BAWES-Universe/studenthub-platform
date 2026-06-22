import { notFound } from "next/navigation";
import { requireRoleCapability } from "@/modules/auth/session";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { formatDate } from "@/modules/workspace/format";
import { getSettingDetail } from "../actions";
import { SettingDetailForm } from "./SettingDetailForm";

export const dynamic = "force-dynamic";

export default async function AdminSettingDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleCapability("admin", "admin.system");
  const { id } = await params;

  const setting = await getSettingDetail(id);
  if (!setting) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Settings"
      title={`${setting.code} — ${setting.key}`}
      metrics={[
        { label: "Code", value: setting.code, note: "Setting namespace" },
        { label: "Created", value: formatDate(setting.created_at), note: "Record created" },
        { label: "Updated", value: formatDate(setting.updated_at), note: "Last modified" }
      ]}
    >
      <SettingDetailForm setting={setting} />
    </WorkspaceShell>
  );
}
