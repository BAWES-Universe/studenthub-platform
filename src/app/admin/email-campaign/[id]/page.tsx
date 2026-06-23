import { notFound } from "next/navigation";
import { requireRoleCapability } from "@/modules/auth/session";
import { FactPanel } from "@/modules/workspace/DetailPanels";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { getEmailCampaign } from "./actions";
import { formatDate } from "@/modules/workspace/format";

export const dynamic = "force-dynamic";

export default async function AdminEmailCampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleCapability("admin", "admin.system");
  const { id } = await params;

  const record = await getEmailCampaign(id);

  if (!record) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Email Campaigns"
      title={`Campaign: ${record.subject ?? "(no subject)"}`}
      metrics={[]}
    >
      <FactPanel
        title="Campaign Details"
        facts={[
          { label: "Campaign UUID", value: record.campaign_uuid },
          { label: "Subject", value: record.subject ?? "—" },
          { label: "Message", value: record.message ? (record.message.length > 200 ? record.message.slice(0, 200) + "…" : record.message) : "—" },
          { label: "Progress", value: record.progress !== null ? `${record.progress}%` : "—" },
          { label: "Status", value: record.status === true ? "Active" : record.status === false ? "Inactive" : "—" },
          { label: "Type", value: record.is_recurring === true ? "Recurring" : record.is_recurring === false ? "One-time" : "—" },
          { label: "Trigger Period", value: record.trigger_period !== null ? `${record.trigger_period} days` : "—" },
          { label: "Target", value: record.target ?? "—" },
          {
            label: "Next Trigger Date",
            value: record.trigger_date_time
              ? formatDate(new Date(record.trigger_date_time))
              : "—",
          },
          {
            label: "Last Trigger Date",
            value: record.last_trigger_date_time
              ? formatDate(new Date(record.last_trigger_date_time))
              : "—",
          },
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
