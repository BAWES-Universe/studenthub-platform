import { notFound } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { requireRoleCapability } from "@/modules/auth/session";
import { FactPanel } from "@/modules/workspace/DetailPanels";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/modules/workspace/format";
import { getFulltimer } from "@/modules/admin/fulltimer/actions";

export const dynamic = "force-dynamic";

export default async function AdminFulltimerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleCapability("admin", "admin.system");
  const { id } = await params;

  const fulltimer = await getFulltimer(id);
  if (!fulltimer) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Full-Timers"
      title={`Full-Timer — ${fulltimer.fulltimer_name}`}
      metrics={[
        { label: "Email", value: fulltimer.fulltimer_email, note: "Contact email" },
        { label: "Registered", value: formatDate(fulltimer.fulltimer_created_datetime), note: "Registration date" },
      ]}
    >
      <FactPanel
        title="Personal Details"
        facts={[
          { label: "UUID", value: fulltimer.fulltimer_uuid },
          { label: "Name", value: fulltimer.fulltimer_name },
          { label: "Email", value: fulltimer.fulltimer_email },
          { label: "Phone", value: fulltimer.fulltimer_phone ?? "—" },
          { label: "Gender", value: fulltimer.fulltimer_gender === true ? "Male" : fulltimer.fulltimer_gender === false ? "Female" : "—" },
          { label: "Birth Date", value: fulltimer.fulltimer_birth_date ? formatDate(fulltimer.fulltimer_birth_date) : "—" },
          { label: "Driving License", value: fulltimer.fulltimer_driving_license === true ? "Yes" : fulltimer.fulltimer_driving_license === false ? "No" : "—" },
        ]}
      />

      <FactPanel
        title="Location & Work"
        facts={[
          { label: "Country", value: fulltimer.country_name ?? "—" },
          { label: "Nationality", value: fulltimer.nationality_name ?? "—" },
          { label: "Area", value: fulltimer.area_name ?? "—" },
          { label: "University", value: fulltimer.university_name ?? "—" },
          { label: "Employed", value: fulltimer.fulltimer_employed === true ? "Yes" : fulltimer.fulltimer_employed === false ? "No" : "—" },
          { label: "Current Salary", value: fulltimer.fulltimer_current_salary ?? "—" },
          { label: "Expected Salary", value: fulltimer.fulltimer_expected_salary ?? "—" },
          { label: "Currency", value: fulltimer.currency_code ?? "—" },
        ]}
      />

      <section className="flex gap-2 p-4">
        <Link href={"/admin/fulltimer" as Route}>
          <Button variant="outline">Back to Full-Timers</Button>
        </Link>
      </section>
    </WorkspaceShell>
  );
}
