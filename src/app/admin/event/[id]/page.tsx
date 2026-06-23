import { notFound } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { requireRoleCapability } from "@/modules/auth/session";
import { FactPanel } from "@/modules/workspace/DetailPanels";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { Button } from "@/components/ui/button";
import { getEvent } from "./actions";
import { formatDate } from "@/modules/workspace/format";

export const dynamic = "force-dynamic";

export default async function AdminEventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleCapability("admin", "request.read.any");
  const { id } = await params;

  const event = await getEvent({ id });

  if (!event) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Events"
      title={`Activity Event — ${event.activity_detail.length > 50 ? event.activity_detail.slice(0, 50) + "…" : event.activity_detail}`}
      metrics={[
        {
          label: "Activity UUID",
          value: event.activity_uuid,
          note: "",
        },
        {
          label: "Staff",
          value: event.staff_name ?? "—",
          note: "",
        },
        {
          label: "Created",
          value: event.activity_created_datetime
            ? formatDate(new Date(event.activity_created_datetime))
            : "—",
          note: "",
        },
      ]}
    >
      <FactPanel
        title="Event Details"
        facts={[
          { label: "Activity UUID", value: event.activity_uuid },
          { label: "Request UUID", value: event.request_uuid },
          { label: "Detail", value: event.activity_detail },
          { label: "Staff Name", value: event.staff_name ?? "—" },
          {
            label: "Created",
            value: event.activity_created_datetime
              ? formatDate(new Date(event.activity_created_datetime))
              : "—",
          },
          {
            label: "Updated",
            value: event.activity_updated_datetime
              ? formatDate(new Date(event.activity_updated_datetime))
              : "—",
          },
        ]}
      />

        <section className="flex gap-2 p-4">
        <Link href={"/admin/event" as Route}>
          <Button variant="outline">Back to Events</Button>
        </Link>
      </section>
    </WorkspaceShell>
  );
}
