import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateEvaluationPdf } from "@/modules/pdf/pdf-service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ uuid: string }> }
) {
  const { uuid } = await params;

  const evaluation = await prisma.candidate_evaluation.findUnique({
    where: { can_eval_uuid: uuid },
  });

  if (!evaluation) {
    return new Response("Evaluation not found", { status: 404 });
  }

  const [candidate, staff] = await Promise.all([
    evaluation.candidate_id
      ? prisma.candidate.findUnique({
          where: { candidate_id: evaluation.candidate_id },
          select: { candidate_name: true },
        })
      : null,
    evaluation.staff_id
      ? prisma.staff.findUnique({
          where: { staff_id: evaluation.staff_id },
          select: { staff_name: true },
        })
      : null,
  ]);

  // Raw query — candidate_evaluation_answer model has @@ignore
  const rows: Array<{ question: string | null; answer: string | null; rating: number | null }> =
    await prisma.$queryRaw`
      SELECT ceq.question, cea.answer, cea.rating
      FROM candidate_evaluation_answer cea
      LEFT JOIN candidate_eval_ques ceq ON cea.ceq_uuid = ceq.ceq_uuid
      WHERE cea.can_eval_uuid = ${uuid}
    `;

  const ratings = rows.filter((r) => r.rating != null).map((r) => r.rating!);

  const buf = await generateEvaluationPdf({
    candidate_name: candidate?.candidate_name ?? "Unknown",
    staff_name: staff?.staff_name ?? undefined,
    department: undefined,
    start_date: evaluation.start_date?.toISOString().split("T")[0] ?? undefined,
    end_date: evaluation.end_date?.toISOString().split("T")[0] ?? undefined,
    score: ratings.length > 0
      ? Math.round((ratings.reduce((a: number, b: number) => a + b, 0) / ratings.length) * 20)
      : undefined,
    answers: rows.map((r: { question: string | null; answer: string | null; rating: number | null }) => ({
      question: r.question ?? undefined,
      answer: r.answer ?? undefined,
      rating: r.rating ?? undefined,
    })),
  });

  return new NextResponse(buf as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="evaluation-${uuid.slice(0, 8)}.pdf"`,
    },
  });
}
