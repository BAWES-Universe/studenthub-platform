"use client";

import { useRouter } from "next/navigation";
import type { Route } from "next";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";

import type { SessionUser } from "@/modules/auth/types";
import type { EmailCampaignListItem } from "@/modules/email-campaigns/schemas";

type Props = {
  session: SessionUser;
  records: EmailCampaignListItem[];
};

function statusBadge(status: boolean | null) {
  if (status === null) return <span className="text-xs text-muted-foreground">—</span>;
  if (status === true)
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-green-600 text-white">
        Active
      </span>
    );
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-muted text-muted-foreground">
      Inactive
    </span>
  );
}

function recurringBadge(isRecurring: boolean | null) {
  if (isRecurring === null) return <span className="text-xs text-muted-foreground">—</span>;
  if (isRecurring === true)
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-sh-coral text-white">
        Recurring
      </span>
    );
  return (
    <span className="text-xs text-muted-foreground">One-time</span>
  );
}

export function AdminEmailCampaignsTable({ session, records }: Props) {
  const router = useRouter();

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin settings"
      title="Email campaigns — manage automated email campaigns across the platform."
      metrics={[
        { label: "Total campaigns", value: records.length, note: "Email campaign records" },
      ]}
    >
      <DataTable
        title="Email Campaigns"
        description="All email campaign entries. Click a row to view details."
        rows={records.map((r) => ({ ...r, id: r.campaign_uuid }))}
        rowHref={(row) => `/admin/email-campaign/${row.campaign_uuid}` as Route}
        columns={[
          {
            key: "subject",
            label: "Subject",
            render: (row) => (
              <span className="text-sm font-medium">
                {row.subject ?? "(no subject)"}
              </span>
            ),
          },
          {
            key: "status",
            label: "Status",
            render: (row) => statusBadge(row.status),
          },
          {
            key: "progress",
            label: "Progress",
            render: (row) =>
              row.progress !== null ? (
                <span className="text-sm">{row.progress}%</span>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              ),
          },
          {
            key: "is_recurring",
            label: "Type",
            render: (row) => recurringBadge(row.is_recurring),
          },
          {
            key: "target",
            label: "Target",
            render: (row) =>
              row.target ? (
                <span className="text-sm capitalize">{row.target}</span>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              ),
          },
          {
            key: "trigger_date",
            label: "Next Trigger",
            render: (row) => {
              if (!row.trigger_date_time) return "—";
              return new Date(row.trigger_date_time).toLocaleDateString();
            },
          },
          {
            key: "created",
            label: "Created",
            render: (row) => {
              if (!row.created_at) return "—";
              return new Date(row.created_at).toLocaleDateString();
            },
          },
        ]}
      />
    </WorkspaceShell>
  );
}
