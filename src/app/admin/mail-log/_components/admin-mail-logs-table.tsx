"use client";

import { useRouter } from "next/navigation";
import type { Route } from "next";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";

import type { SessionUser } from "@/modules/auth/types";
import type { MailLogListItem } from "@/modules/mail-logs/schemas";

type Props = {
  session: SessionUser;
  records: MailLogListItem[];
};

export function AdminMailLogsTable({ session, records }: Props) {
  const router = useRouter();

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin settings"
      title="Mail logs — view system email history across the platform."
      metrics={[
        { label: "Total emails", value: records.length, note: "Logged email records" },
      ]}
    >
      <DataTable
        title="Mail Logs"
        description="All mail log entries. Click a row to view details."
        rows={records.map((r) => ({ ...r, id: r.mail_uuid }))}
        rowHref={(row) => `/admin/mail-log/${row.mail_uuid}` as Route}
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
            key: "from",
            label: "From",
            render: (row) => (
              <span className="text-sm truncate max-w-[250px] inline-block align-middle" title={row.from ?? undefined}>
                {row.from ?? "—"}
              </span>
            ),
          },
          {
            key: "to",
            label: "To",
            render: (row) => (
              <span className="text-sm truncate max-w-[250px] inline-block align-middle" title={row.to ?? undefined}>
                {row.to ?? "—"}
              </span>
            ),
          },
          {
            key: "app",
            label: "App",
            render: (row) =>
              row.app ? (
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-blue-zendesk text-white">
                  {row.app}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              ),
          },
          {
            key: "created",
            label: "Sent",
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
