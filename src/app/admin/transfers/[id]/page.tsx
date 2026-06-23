import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireRoleCapability } from "@/modules/auth/session";
import { CompactList, FactPanel } from "@/modules/workspace/DetailPanels";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { getAdminTransferDetail } from "@/modules/workspace/data";
import { TransferActionBar } from "@/modules/finance/TransferActionBar";
import { formatDate, formatMoney } from "@/modules/workspace/format";

export const dynamic = "force-dynamic";

export default async function AdminTransferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRoleCapability("admin", "finance.read");
  const { id } = await params;
  const data = await getAdminTransferDetail(Number(id));

  if (!data.transfer) {
    notFound();
  }

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin / Transfer"
      title={`Transfer #${data.transfer.transfer_id}`}
      metrics={data.metrics}
      primary={{ title: "Candidate Payouts", rows: data.candidates }}
      secondary={{ title: "Invoices", rows: data.invoices }}
    >
      <Suspense fallback={<div className="transferActions"><p>Loading actions…</p></div>}>
        <TransferActionBar data={data} />
      </Suspense>

      <FactPanel
        title="Transfer Run"
        facts={[
          { label: "Company", value: data.transfer.company?.company_name },
          { label: "Period", value: `${formatDate(data.transfer.start_date)} to ${formatDate(data.transfer.end_date)}` },
          { label: "Payment Received", value: formatDate(data.transfer.payment_received_on) },
          { label: "Company Total", value: formatMoney(data.transfer.company_total, data.transfer.currency_code ?? "KWD") },
          { label: "Created By", value: data.transfer.staff_transfer_transfer_created_byTostaff?.staff_name },
          { label: "Updated By", value: data.transfer.staff_transfer_transfer_updated_byTostaff?.staff_name },
          { label: "Created", value: formatDate(data.transfer.transfer_created_at) },
          { label: "Updated", value: formatDate(data.transfer.transfer_updated_at) }
        ]}
      />
      <section className="flex flex-col mt-5">
        <CompactList title="Transfer File Entries" rows={data.fileEntries} />
      </section>
    </WorkspaceShell>
  );
}
