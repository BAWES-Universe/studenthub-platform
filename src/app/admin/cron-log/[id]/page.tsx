import { requireRoleCapability } from "@/modules/auth/session";
import { getCronLog } from "../actions";
import { notFound } from "next/navigation";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AdminCronLogDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireRoleCapability("admin", "admin.read");
  const record = await getCronLog(Number(id));

  if (!record) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link
          href="/admin/cron-log"
          className={cn(buttonVariants({ variant: "outline" }), "text-sm")}
        >
          &larr; Back
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Cron Log #{record.id}
          </h1>
          <p className="text-sm text-muted-foreground">
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
              {record.task}
            </code>
          </p>
        </div>
      </div>

      <div className="grid gap-4 rounded-lg border p-6">
        <div className="grid grid-cols-[140px_1fr] gap-3 text-sm">
          <span className="font-semibold text-muted-foreground">ID</span>
          <span className="font-mono">#{record.id}</span>

          <span className="font-semibold text-muted-foreground">Task</span>
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono w-fit">
            {record.task}
          </code>

          <span className="font-semibold text-muted-foreground">Last Ran</span>
          <span>
            {record.last_ran_at
              ? record.last_ran_at.toLocaleString()
              : "Never"}
          </span>

          <span className="font-semibold text-muted-foreground align-top">
            Output
          </span>
          <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-xs font-mono max-h-96 overflow-auto">
            {record.last_output || "—"}
          </pre>
        </div>
      </div>
    </div>
  );
}
