import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateOfferLetterPdf } from "@/modules/pdf/pdf-service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ uuid: string }> }
) {
  const { uuid } = await params;

  const fulltimer = await prisma.fulltimer.findUnique({
    where: { fulltimer_uuid: uuid },
  });

  if (!fulltimer) {
    return new Response("Fulltimer not found", { status: 404 });
  }

  const buf = await generateOfferLetterPdf({
    fulltimer_name: fulltimer.fulltimer_name,
    fulltimer_email: fulltimer.fulltimer_email ?? undefined,
    fulltimer_phone: fulltimer.fulltimer_phone ?? undefined,
    position: undefined,
    start_date: undefined,
    salary: fulltimer.fulltimer_expected_salary ?? undefined,
  });

  return new NextResponse(buf as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="offer-letter-${uuid.slice(0, 8)}.pdf"`,
    },
  });
}
