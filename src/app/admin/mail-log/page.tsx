import { requireRoleCapability } from "@/modules/auth/session";
import { listMailLogs } from "./actions";
import { AdminMailLogsTable } from "./_components";

export const dynamic = "force-dynamic";

export default async function AdminMailLogPage() {
  const session = await requireRoleCapability("admin", "admin.system");
  const result = await listMailLogs({ limit: 100 });

  return <AdminMailLogsTable session={session} records={result.records} />;
}
