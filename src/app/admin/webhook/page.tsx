import type { Route } from "next";
import { requireRoleCapability } from "@/modules/auth/session";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { getAdminWebhookRows } from "@/modules/workspace/data";
import { Card } from "@/components/ui/card";
import { createWebhook } from "./actions";
import { CreateWebhookForm } from "./CreateWebhookForm";

export const dynamic = "force-dynamic";

export default async function AdminWebhookPage() {
  const session = await requireRoleCapability("admin", "admin.system");
  const rows = await getAdminWebhookRows();

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin"
      title="Webhooks — manage incoming webhook endpoints"
      metrics={[
        { label: "Webhooks", value: rows.length, note: "Registered endpoints" },
      ]}
    >
      <section className="mb-6">
        <Card className="p-5">
          <h3 className="text-sm font-semibold mb-3 text-foreground">Add a webhook</h3>
          <CreateWebhookForm />
        </Card>
      </section>

      <DataTable
        title="Webhooks"
        description="List of all webhook endpoints."
        rows={rows}
        rowHref={(row) => `/admin/webhook/${row.id}` as Route}
        columns={[
          {
            key: "event",
            label: "Event",
            render: (row) => <span className="text-sm font-medium text-foreground">{row.event}</span>,
          },
          {
            key: "endpoint",
            label: "Endpoint",
            render: (row) => (
              <span className="text-sm text-muted-foreground font-mono max-w-[300px] truncate inline-block">
                {row.endpoint}
              </span>
            ),
          },
          {
            key: "method",
            label: "Method",
            render: (row) => <span className="text-sm text-muted-foreground">{row.method}</span>,
          },
          {
            key: "created",
            label: "Created",
            render: (row) => <span className="text-sm text-muted-foreground">{row.created}</span>,
          },
          {
            key: "updated",
            label: "Updated",
            render: (row) => <span className="text-sm text-muted-foreground">{row.updated}</span>,
          },
        ]}
      />
    </WorkspaceShell>
  );
}
