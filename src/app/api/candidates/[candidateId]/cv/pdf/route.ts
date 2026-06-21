import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateCandidateCvPdf } from "@/modules/pdf/pdf-service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ candidateId: string }> }
) {
  const { candidateId } = await params;
  const id = Number(candidateId);

  if (isNaN(id)) {
    return new Response("Invalid candidate ID", { status: 400 });
  }

  const candidate = await prisma.candidate.findUnique({
    where: { candidate_id: id },
    include: {
      candidate_education: {
        include: { degree: true, university: true },
      },
      candidate_experience: { where: { deleted: 0 } },
      candidate_skill: { where: { deleted: 0 } },
      candidate_language: { where: { deleted: 0 } },
    },
  });

  if (!candidate) {
    return new Response("Candidate not found", { status: 404 });
  }

  const buf = await generateCandidateCvPdf({
    candidate_name: candidate.candidate_name,
    candidate_name_ar: candidate.candidate_name_ar ?? undefined,
    candidate_email: candidate.candidate_email ?? undefined,
    candidate_phone: candidate.candidate_phone ?? undefined,
    candidate_objective: candidate.candidate_objective ?? undefined,
    candidate_intro: candidate.candidate_intro ?? undefined,
    candidate_education: candidate.candidate_education.map((e) => ({
      degree: e.degree?.degree_name_en ?? undefined,
      institution: e.university?.university_name_en ?? undefined,
      year: e.graduation_year ?? undefined,
    })),
    candidate_experience: candidate.candidate_experience.map((e) => ({
      employer: e.employer ?? undefined,
      role: e.experience ?? undefined,
      start_year: e.start_year ?? undefined,
      end_year: e.end_year ?? undefined,
    })),
    candidate_skills: candidate.candidate_skill
      .filter((s) => s.skill)
      .map((s) => s.skill!),
    candidate_languages: candidate.candidate_language
      .filter((l) => l.language)
      .map((l) => l.language!),
  });

  return new NextResponse(buf as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="cv-${candidate.candidate_uid || candidateId}.pdf"`,
    },
  });
}
