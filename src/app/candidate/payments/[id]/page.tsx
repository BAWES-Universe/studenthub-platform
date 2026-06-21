import { notFound } from "next/navigation";
import { requireRoleCapability } from "@/modules/auth/session";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CompactList, FactPanel } from "@/modules/workspace/DetailPanels";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { getCandidateTransferDetail } from "@/modules/workspace/data";

export const dynamic = "force-dynamic";

export default async function CandidatePaymentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleCapability("candidate", "candidate.read.own");
  const { id } = await params;
  const data = await getCandidateTransferDetail(Number(id), Number(session.id));

  if (!data) {
    notFound();
  }

  const { transferCandidate: tc, transfer } = data;

  const facts = [
    { label: "Hours", value: tc.hours },
    { label: "Hourly Rate", value: tc.hourlyRate },
    { label: "Bonus", value: tc.bonus },
    { label: "Your Total", value: tc.candidateTotal },
    { label: "Company Total", value: tc.companyTotal },
    { label: "Transfer Cost", value: tc.cost },
    { label: "Status", value: tc.paid },
    { label: "Store", value: tc.store },
    { label: "Beneficiary", value: tc.beneficiary },
    { label: "IBAN", value: tc.iban },
    { label: "Bank", value: tc.bank },
    { label: "Created", value: tc.created },
    { label: "Updated", value: tc.updated },
  ];

  const transferFacts = transfer
    ? [
        { label: "Company", value: tc.company },
        { label: "Period", value: transfer.period },
        { label: "Payment Received", value: transfer.paymentReceived },
      ]
    : [];

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Candidate / Payments"
      title={`Payment #${tc.id}`}
      metrics={[
        { label: "Total", value: tc.candidateTotal, note: "Your payout" },
        { label: "Status", value: tc.paid, note: "Payment status" },
        { label: "Hours", value: tc.hours, note: "Worked" },
      ]}
    >
      <FactPanel title="Payment Breakdown" facts={facts} />
      {transfer && <FactPanel title="Transfer Run" facts={transferFacts} />}
      {data.invoices.length > 0 && (
        <Card className="mt-5">
          <CardHeader className="border-b border-border px-[18px] py-[18px]">
            <CardTitle className="m-0 text-lg">Receipts & Invoices</CardTitle>
          </CardHeader>
          <CardContent className="p-3.5">
            <p className="text-muted-foreground text-sm mb-3">
              Paid invoices linked to this payment period serve as your receipt.
            </p>
            <CompactList title="Invoices" rows={data.invoices} />
          </CardContent>
        </Card>
      )}
    </WorkspaceShell>
  );
}
