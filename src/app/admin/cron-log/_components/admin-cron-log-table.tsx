"use client";

import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import Link from "next/link";

import type { SessionUser } from "@/modules/auth/types";
import type { CronLogItem } from "../schemas";

type Props = {
  session: SessionUser;
  records: CronLogItem[];
};

export function AdminCronLogTable({ session, records }: Props) {
  const rows = records.map((r) => ({ ...r, id: r.id }));

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin"
      title="Cron Logs — Monitor scheduled task execution history."
      metrics={[
        { label: "Total entries", value: records.length, note: "Cron execution log" },
      ]}
    >
      <DataTable
        title="Cron Logs"
        description="Scheduled task execution history. Click a row to view details."
        rows={rows}
        columns={[
          {
            key: "id",
            label: "ID",
            render: (row) => (
              <Link
                href={`/admin/cron-log/${row.id}`}
                className="font-mono text-xs underline underline-offset-2"
              >
                #{row.id}
              </Link>
            ),
          },
          {
            key: "task",
            label: "Task",
            render: (row) => (
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                {row.task}
              </code>
            ),
          },
          {
            key: "last_ran_at",
            label: "Last Ran",
            render: (row) => {
              if (!row.last_ran_at) return <span className="text-muted-foreground">Never</span>;
              return (
                <span className="text-xs text-muted-foreground">
                  {new Date(row.last_ran_at).toLocaleString()}
                </span>
              );
            },
          },
          {
            key: "last_output",
            label: "Output",
            render: (row) => {
              if (!row.last_output) return <span className="text-muted-foreground">—</span>;
              const truncated =
                row.last_output.length > 60
                  ? `${row.last_output.slice(0, 60)}…`
                  : row.last_output;
              return (
                <span className="font-mono text-xs text-muted-foreground">
                  {truncated}
                </span>
              );
            },
          },
        ]}
      />
    </WorkspaceShell>
  );
}
