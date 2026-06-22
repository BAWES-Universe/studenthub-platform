import { notFound } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { requireRoleCapability } from "@/modules/auth/session";
import { FactPanel } from "@/modules/workspace/DetailPanels";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/modules/workspace/format";
import { getWebhookDetail } from "../actions";

export const dynamic = "force-dynamic";

export default async function AdminWebhookDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleCapability("admin", "admin.system");
  const { id } = await params;
  const webhookId = Number(id);

  if (Number.isNaN(webhookId)) {
    notFound();
  }

  const webhook = await getWebhookDetail(webhookId);

  if (!webhook) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Webhooks"
      title={`Webhook — ${webhook.event}`}
      metrics={[
        {
          label: "Event",
          value: webhook.event,
          note: "Trigger event",
        },
        {
          label: "Method",
          value: webhook.method ?? "POST",
          note: "HTTP method",
        },
      ]}
    >
      <FactPanel
        title="Webhook Details"
        facts={[
          { label: "ID", value: String(webhook.webhook_id) },
          { label: "Event", value: webhook.event },
          { label: "Endpoint", value: webhook.endpoint },
          { label: "Method", value: webhook.method ?? "POST" },
          { label: "Created", value: webhook.created_at ? formatDate(webhook.created_at) : "—" },
          { label: "Updated", value: webhook.updated_at ? formatDate(webhook.updated_at) : "—" },
        ]}
      />

      <section className="flex gap-2 p-4">
        <Link href={"/admin/webhook" as Route}>
          <Button variant="outline">Back to Webhooks</Button>
        </Link>
      </section>
    </WorkspaceShell>
  );
}
