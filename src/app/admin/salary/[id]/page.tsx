import { notFound } from "next/navigation";
import { requireRoleCapability } from "@/modules/auth/session";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { formatDate } from "@/modules/workspace/format";
import { getSalaryDetail } from "@/modules/admin/salary/actions";
import { SalaryDetailForm } from "./SalaryDetailForm";

export const dynamic = "force-dynamic";

export default async function AdminSalaryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleCapability("admin", "admin.system");
  const { id } = await params;

  const salary = await getSalaryDetail(id);
  if (!salary) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Salary"
      title={`Salary — ${salary.staff_name}`}
      metrics={[
        {
          label: "Amount",
          value: salary.salary
            ? `${salary.salary.toFixed(3)} ${salary.salary_currency ?? "KWD"}`
            : "—",
          note: "Salary amount",
        },
        {
          label: "Date",
          value: salary.salary_date ?? "—",
          note: "Salary date",
        },
        {
          label: "Created",
          value: salary.created_at ? formatDate(new Date(salary.created_at)) : "—",
          note: "Record created",
        },
        {
          label: "Updated",
          value: salary.updated_at ? formatDate(new Date(salary.updated_at)) : "—",
          note: "Last modified",
        },
      ]}
    >
      <SalaryDetailForm salary={salary} />
    </WorkspaceShell>
  );
}
