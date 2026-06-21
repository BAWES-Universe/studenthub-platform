import { requireRoleCapability } from "@/modules/auth/session";
import { listDailyStandups } from "@/modules/admin/daily-standup/actions";
import { AdminDailyStandupTable } from "./_components";

export const dynamic = "force-dynamic";

export default async function AdminDailyStandupPage() {
  const session = await requireRoleCapability("admin", "admin.read");
  const { records } = await listDailyStandups({ limit: 200 });

  return <AdminDailyStandupTable session={session} records={records} />;
}
