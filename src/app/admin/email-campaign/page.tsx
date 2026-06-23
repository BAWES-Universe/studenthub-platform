import { requireRoleCapability } from "@/modules/auth/session";
import { listEmailCampaigns } from "./actions";
import { AdminEmailCampaignsTable } from "./_components";

export const dynamic = "force-dynamic";

export default async function AdminEmailCampaignPage() {
  const session = await requireRoleCapability("admin", "admin.system");
  const result = await listEmailCampaigns({ limit: 100 });

  return <AdminEmailCampaignsTable session={session} records={result.records} />;
}
