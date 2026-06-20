import { requireRoleCapability } from "@/modules/auth/session";
import { listCountries } from "@/modules/admin/country/actions";
import { AdminCountryTable } from "./_components";

export const dynamic = "force-dynamic";

export default async function AdminCountryPage() {
  const session = await requireRoleCapability("admin", "admin.system");
  const { records } = await listCountries({ limit: 200 });

  return <AdminCountryTable session={session} records={records} />;
}
