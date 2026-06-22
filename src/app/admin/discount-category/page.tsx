import { requireRoleCapability } from "@/modules/auth/session";
import { listDiscountCategories } from "@/modules/admin/discount-category/actions";
import { AdminDiscountCategoryTable } from "./_components";

export const dynamic = "force-dynamic";

export default async function AdminDiscountCategoryPage() {
  const session = await requireRoleCapability("admin", "admin.system");
  const { records } = await listDiscountCategories({ limit: 200 });

  return <AdminDiscountCategoryTable session={session} records={records} />;
}
