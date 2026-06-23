import { requireRoleCapability } from "@/modules/auth/session";
import { listDegreeGroups } from "./actions";
import { AdminDegreeGroupsTable } from "./_components";

export const dynamic = "force-dynamic";

export default async function AdminDegreeGroupsPage() {
  const session = await requireRoleCapability("admin", "admin.system");
  const result = await listDegreeGroups({ limit: 100 });

  return (
    <AdminDegreeGroupsTable session={session} degreeGroups={result.records} />
  );
}
