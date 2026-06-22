"use client";

import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";

import type { Route } from "next";

import type { SessionUser } from "@/modules/auth/types";
import type { StoryItem } from "../schemas";

type Props = {
  session: SessionUser;
  stories: StoryItem[];
};

export function AdminStoriesTable({ session, stories }: Props) {

  const statusLabel = (status: number) => {
    const labels: Record<number, string> = {
      0: "New",
      1: "In Progress",
      2: "Completed",
      3: "Cancelled",
    };
    return labels[status] ?? `Unknown (${status})`;
  };

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin settings"
      title="Manage stories — track consultancy engagements and their status."
      metrics={[
        { label: "Total stories", value: stories.length, note: "Stories in the system" },
      ]}
    >
      <DataTable
        title="Stories"
        description="All consultancy stories. Click a row to view details."
        rows={stories.map((s) => ({ ...s, id: s.story_uuid }))}
        rowHref={(row) => `/admin/story/${row.story_uuid}` as Route}
        columns={[
          {
            key: "story_uuid",
            label: "Story UUID",
            render: (row) => (
              <span className="font-mono text-xs">{row.story_uuid.slice(0, 12)}...</span>
            ),
          },
          {
            key: "request_uuid",
            label: "Request",
            render: (row) => (
              <span className="font-mono text-xs">{row.request_uuid.slice(0, 12)}...</span>
            ),
          },
          {
            key: "story_status",
            label: "Status",
            render: (row) => statusLabel(row.story_status),
          },
          {
            key: "number_of_employees",
            label: "Employees",
            render: (row) =>
              row.number_of_employees != null ? String(row.number_of_employees) : "—",
          },
          {
            key: "story_time_spent",
            label: "Time spent",
            render: (row) =>
              row.story_time_spent != null ? `${row.story_time_spent}m` : "—",
          },
          {
            key: "story_last_updated_at",
            label: "Last updated",
            render: (row) => {
              if (!row.story_last_updated_at) return "—";
              return new Date(row.story_last_updated_at).toLocaleDateString();
            },
          },
        ]}
      />
    </WorkspaceShell>
  );
}