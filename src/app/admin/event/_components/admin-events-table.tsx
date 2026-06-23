"use client";

import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { DataTable } from "@/modules/workspace/DataTable";
import type { Route } from "next";
import type { SessionUser } from "@/modules/auth/types";
import type { EventItem } from "@/modules/admin/event/schemas";
import { formatDate } from "@/modules/workspace/format";

type Props = {
  session: SessionUser;
  events: EventItem[];
};

export function AdminEventsTable({ session, events }: Props) {
  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin settings"
      title="Activity Events — view request activity records."
      metrics={[
        { label: "Events", value: events.length, note: "Recent activity events" },
      ]}
    >
      <DataTable
        title="Activity Events"
        description="List of all request activity records."
        rows={events.map((r) => ({ ...r, id: String(r.activity_uuid) }))}
        rowHref={(row) => `/admin/event/${row.activity_uuid}` as Route}
        columns={[
          {
            key: "activity_detail",
            label: "Detail",
            render: (row) => (
              <span className="text-sm font-medium text-foreground">
                {row.activity_detail.length > 60
                  ? row.activity_detail.slice(0, 60) + "…"
                  : row.activity_detail}
              </span>
            ),
          },
          {
            key: "staff_name",
            label: "Staff",
            render: (row) => (
              <span className="text-sm text-muted-foreground">
                {row.staff_name ?? "—"}
              </span>
            ),
          },
          {
            key: "request_uuid",
            label: "Request",
            render: (row) => (
              <span className="text-sm text-muted-foreground font-mono">
                {row.request_uuid.length > 16
                  ? row.request_uuid.slice(0, 16) + "…"
                  : row.request_uuid}
              </span>
            ),
          },
          {
            key: "activity_created_datetime",
            label: "Created",
            render: (row) => (
              <span className="text-sm text-muted-foreground">
                {row.activity_created_datetime
                  ? formatDate(new Date(row.activity_created_datetime))
                  : "—"}
              </span>
            ),
          },
        ]}
      />
    </WorkspaceShell>
  );
}
