import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateBankAdvicePdf } from "@/modules/pdf/pdf-service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ uuid: string }> }
) {
  const { uuid } = await params;

  const bankAdvice = await prisma.transfer_bank_advice.findUnique({
    where: { tba_uuid: uuid },
  });

  if (!bankAdvice) {
    return new Response("Bank advice not found", { status: 404 });
  }

  // Look up transfer details
  let beneficiaryName: string | undefined;
  let beneficiaryIban: string | undefined;
  let amount: string | undefined;
  let companyName: string | undefined;

  if (bankAdvice.serial_no) {
    const transferCandidate = await prisma.transfer_candidate.findFirst({
      where: { transfer_file_id: bankAdvice.serial_no },
      include: { company: { select: { company_name: true } } },
    });
    if (transferCandidate) {
      beneficiaryName = transferCandidate.transfer_benef_name ?? undefined;
      beneficiaryIban = transferCandidate.transfer_benef_iban ?? undefined;
      if (transferCandidate.candidate_total) {
        amount = `${Number(transferCandidate.candidate_total).toFixed(3)} ${transferCandidate.currency_code || "KWD"}`;
      }
      companyName = transferCandidate.company?.company_name ?? undefined;
    }
  }

  const buf = await generateBankAdvicePdf({
    serial_no: bankAdvice.serial_no ?? undefined,
    beneficiary_name: beneficiaryName,
    beneficiary_iban: beneficiaryIban,
    amount,
    transfer_date: bankAdvice.created_at?.toISOString().split("T")[0] ?? undefined,
    company_name: companyName,
  });

  return new NextResponse(buf as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="bank-advice-${bankAdvice.serial_no || uuid.slice(0, 8)}.pdf"`,
    },
  });
}
