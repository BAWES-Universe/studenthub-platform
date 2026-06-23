import { requireRoleCapability } from "@/modules/auth/session";
import { listCronLogs } from "./actions";
import { AdminCronLogTable } from "./_components";

export const dynamic = "force-dynamic";

export default async function AdminCronLogPage() {
  const session = await requireRoleCapability("admin", "admin.read");
  const { records } = await listCronLogs({ limit: 100 });

  return <AdminCronLogTable session={session} records={records} />;
}
