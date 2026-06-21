"use client";

import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import type { Route } from "next";
import type { SessionUser } from "@/modules/auth/types";
import type { DailyStandupAnswerItem } from "@/modules/admin/daily-standup/schemas";

type Props = {
  session: SessionUser;
  records: DailyStandupAnswerItem[];
};

export function AdminDailyStandupTable({ session, records }: Props) {
  const uniqueStaffIds = new Set(records.map((r) => r.staff_id).filter(Boolean));

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin"
      title="Daily Standup — staff check-in answers."
      metrics={[
        { label: "Answers", value: records.length, note: "Total standup answers" },
        { label: "Staff Members", value: uniqueStaffIds.size, note: "Unique staff" },
      ]}
    >
      <DataTable
        title="Daily Standup Answers"
        description="All submitted daily standup answers across staff."
        rows={records.map((r) => ({ ...r, id: r.answer_uuid }))}
        rowHref={(row) => `/admin/daily-standup/${row.answer_uuid}` as Route}
        columns={[
          {
            key: "question",
            label: "Question",
            render: (row) => (
              <span className="text-sm font-medium text-foreground max-w-xs truncate">
                {row.question ?? "—"}
              </span>
            ),
          },
          {
            key: "answer",
            label: "Answer",
            render: (row) => (
              <span className="text-sm text-muted-foreground max-w-sm truncate">
                {row.answer ?? "—"}
              </span>
            ),
          },
          {
            key: "staff_id",
            label: "Staff ID",
            render: (row) => (
              <span className="text-sm text-muted-foreground">
                {row.staff_id != null ? `#${row.staff_id}` : "—"}
              </span>
            ),
          },
          {
            key: "updated_at",
            label: "Updated",
            render: (row) => (
              <span className="text-sm text-muted-foreground">
                {row.updated_at
                  ? new Date(row.updated_at).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "—"}
              </span>
            ),
          },
        ]}
      />
    </WorkspaceShell>
  );
}
