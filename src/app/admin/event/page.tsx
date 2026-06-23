import { requireRoleCapability } from "@/modules/auth/session";
import { listEvents } from "@/modules/admin/event/actions";
import { AdminEventsTable } from "./_components";

export const dynamic = "force-dynamic";

export default async function AdminEventPage() {
  const session = await requireRoleCapability("admin", "request.read.any");
  const { events } = await listEvents({ limit: 200 });

  return <AdminEventsTable session={session} events={events} />;
}
