import { notFound } from "next/navigation";
import { requireRoleCapability } from "@/modules/auth/session";
import { CompactList, FactPanel } from "@/modules/workspace/DetailPanels";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { getCompanyAccountDetail } from "@/modules/workspace/data";
import { formatDate } from "@/modules/workspace/format";

export const dynamic = "force-dynamic";

export default async function CompanyAccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRoleCapability("company", "company.read.linked");
  const { id } = await params;
  const data = await getCompanyAccountDetail(session.id, Number(id));

  if (!data?.company) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Company / Account"
      title={data.company.company_name}
      metrics={data.metrics}
      primary={{ title: "Requests", rows: data.requests }}
      secondary={{ title: "Contacts", rows: data.contacts }}
    >
      <FactPanel
        title="Account"
        facts={[
          { label: "Email", value: data.company.company_email },
          { label: "Common Name", value: data.company.company_common_name_en },
          { label: "Website", value: data.company.company_website },
          { label: "Country", value: data.company.country?.country_name_en },
          { label: "Created", value: formatDate(data.company.company_created_at) },
          { label: "Updated", value: formatDate(data.company.company_updated_at) }
        ]}
      />
      <section className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-5">
        <CompactList title="Stores" rows={data.stores} />
        <CompactList title="Notes" rows={data.notes} />
      </section>
    </WorkspaceShell>
  );
}
