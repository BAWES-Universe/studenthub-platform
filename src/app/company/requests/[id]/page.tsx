import { notFound } from "next/navigation";
import { requireRoleCapability } from "@/modules/auth/session";
import { CompactList, FactPanel } from "@/modules/workspace/DetailPanels";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { getCompanyRequestDetail } from "@/modules/workspace/data";
import { formatDate } from "@/modules/workspace/format";

export const dynamic = "force-dynamic";

export default async function CompanyRequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRoleCapability("company", "request.read.linked");
  const { id } = await params;
  const data = await getCompanyRequestDetail(session.id, id);

  if (!data?.request) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Company / Request"
      title={data.request.request_position_title ?? "Untitled request"}
      metrics={data.metrics}
      primary={{ title: "Applications", rows: data.applications }}
      secondary={{ title: "Invitations", rows: data.invitations }}
    >
      <FactPanel
        title="Request Brief"
        facts={[
          { label: "Company", value: data.request.company?.company_name },
          { label: "Contact", value: data.request.contact?.contact_name },
          { label: "Owner", value: data.request.staff?.staff_name },
          { label: "Compensation", value: data.request.request_compensation },
          { label: "Location", value: data.request.request_location },
          { label: "Created", value: formatDate(data.request.request_created_datetime) },
          { label: "Updated", value: formatDate(data.request.request_updated_datetime) }
        ]}
      />
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CompactList title="Interviews" rows={data.interviews} />
        <CompactList title="Stories" rows={data.stories} />
      </section>
    </WorkspaceShell>
  );
}
