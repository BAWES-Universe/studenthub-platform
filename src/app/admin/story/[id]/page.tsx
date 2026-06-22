import { notFound } from "next/navigation";
import { requireRoleCapability } from "@/modules/auth/session";
import { FactPanel } from "@/modules/workspace/DetailPanels";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { getStory } from "./actions";
import { formatDate } from "@/modules/workspace/format";

export const dynamic = "force-dynamic";

export default async function AdminStoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleCapability("admin", "admin.system");
  const { id } = await params;

  const data = await getStory({ storyUuid: id });

  if (!data.story) {
    notFound();
  }

  const story = data.story;

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
        eyebrow="Admin / Stories"
        title={story.story_uuid.slice(0, 16) + "..."}
        metrics={[
          { label: "Status", value: statusLabel(story.story_status), note: "Current story status" },
          {
            label: "Employees",
            value: story.number_of_employees != null ? String(story.number_of_employees) : "—",
            note: "Assigned employees",
          },
          {
            label: "Time spent",
            value: story.story_time_spent != null ? `${story.story_time_spent}m` : "—",
            note: "Total minutes logged",
          },
        ]}
      >
        <FactPanel
          title="Story Details"
          facts={[
            { label: "Story UUID", value: story.story_uuid },
            { label: "Request UUID", value: story.request_uuid },
            {
              label: "Suggestion UUID",
              value: story.suggestion_uuid ?? "—",
            },
            {
              label: "Staff ID",
              value: story.staff_id != null ? String(story.staff_id) : "—",
            },
            {
              label: "Number of employees",
              value:
                story.number_of_employees != null
                  ? String(story.number_of_employees)
                  : "—",
            },
            { label: "Status", value: statusLabel(story.story_status) },
            {
              label: "Is old",
              value: story.is_old != null ? (story.is_old ? "Yes" : "No") : "—",
            },
            {
              label: "Time spent (minutes)",
              value:
                story.story_time_spent != null
                  ? String(story.story_time_spent)
                  : "—",
            },
            {
              label: "Created",
              value: story.story_created_at
                ? formatDate(new Date(story.story_created_at))
                : "—",
            },
            {
              label: "Last updated",
              value: story.story_last_updated_at
                ? formatDate(new Date(story.story_last_updated_at))
                : "—",
            },
          ]}
        />
      </WorkspaceShell>
  );
}