import { notFound } from "next/navigation";
import { requireRoleCapability } from "@/modules/auth/session";
import { FactPanel } from "@/modules/workspace/DetailPanels";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { getMailLog } from "./actions";
import { formatDate } from "@/modules/workspace/format";

export const dynamic = "force-dynamic";

export default async function AdminMailLogDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleCapability("admin", "admin.system");
  const { id } = await params;

  const record = await getMailLog(id);

  if (!record) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Mail Log"
      title={`Mail: ${record.subject ?? "(no subject)"}`}
      metrics={[]}
    >
      <FactPanel
        title="Mail Details"
        facts={[
          { label: "Mail UUID", value: record.mail_uuid },
            { label: "From", value: record.from ?? "—" },
            { label: "To", value: record.to ?? "—" },
            { label: "Subject", value: record.subject ?? "—" },
            { label: "App", value: record.app ?? "—" },
            {
              label: "Created",
              value: record.created_at
                ? formatDate(new Date(record.created_at))
                : "—",
            },
            {
              label: "Updated",
              value: record.updated_at
                ? formatDate(new Date(record.updated_at))
                : "—",
            },
          ]}
        />
      </WorkspaceShell>
  );
}
