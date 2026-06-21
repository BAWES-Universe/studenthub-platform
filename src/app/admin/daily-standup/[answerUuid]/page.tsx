import { notFound } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { requireRoleCapability } from "@/modules/auth/session";
import { FactPanel } from "@/modules/workspace/DetailPanels";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { Button } from "@/components/ui/button";
import { getDailyStandupAnswer } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminDailyStandupDetailPage({
  params,
}: {
  params: Promise<{ answerUuid: string }>;
}) {
  const session = await requireRoleCapability("admin", "admin.read");
  const { answerUuid } = await params;

  if (!answerUuid) {
    notFound();
  }

  const answer = await getDailyStandupAnswer(answerUuid);

  if (!answer) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Daily Standup"
      title={`Answer — ${answer.question ?? "Unnamed"}`}
      metrics={[
        {
          label: "Staff ID",
          value: answer.staff_id != null ? `#${answer.staff_id}` : "—",
          note: "Staff member",
        },
        {
          label: "Updated",
          value: answer.updated_at
            ? new Date(answer.updated_at).toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })
            : "—",
          note: "Last updated",
        },
      ]}
    >
      <FactPanel
        title="Answer Details"
        facts={[
          { label: "Answer UUID", value: answer.answer_uuid },
          { label: "Staff ID", value: answer.staff_id != null ? String(answer.staff_id) : "—" },
          { label: "Question UUID", value: answer.question_uuid ?? "—" },
          { label: "Question", value: answer.question ?? "—" },
          { label: "Answer", value: answer.answer ?? "—" },
          {
            label: "Created At",
            value: answer.created_at
              ? new Date(answer.created_at).toLocaleString("en-US")
              : "—",
          },
          {
            label: "Updated At",
            value: answer.updated_at
              ? new Date(answer.updated_at).toLocaleString("en-US")
              : "—",
          },
        ]}
      />

      <section className="flex gap-2 p-4">
        <Link href={"/admin/daily-standup" as Route}>
          <Button variant="outline">Back to Daily Standup</Button>
        </Link>
      </section>
    </WorkspaceShell>
  );
}
