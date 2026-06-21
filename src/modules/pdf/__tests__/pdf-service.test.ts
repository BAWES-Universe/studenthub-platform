import { describe, it, expect } from "vitest";
import {
  generateCandidateCvPdf,
  generateEvaluationPdf,
  generateOfferLetterPdf,
  generateBankAdvicePdf,
} from "../pdf-service";

// ---------------------------------------------------------------------------
// Pure logic: PDF generation service
//
// These tests verify that pdfmake produces valid PDF buffers.
// Content is compressed (FlateDecode) inside the PDF so we validate
// structure rather than raw text. Pure functions — no Prisma mocking needed.
// ---------------------------------------------------------------------------

const mockCandidate = {
  candidate_name: "Ahmed Al-Mutairi",
  candidate_name_ar: "أحمد المطيري",
  candidate_email: "ahmed@example.com",
  candidate_phone: "965-12345678",
  candidate_objective: "Experienced software engineer",
  candidate_intro: "Passionate developer with 5 years experience.",
  candidate_education: [
    { degree: "Bachelor of CS", institution: "Kuwait University", year: 2020 },
  ],
  candidate_experience: [
    { employer: "Tech Co", role: "Software Engineer", start_year: 2021, end_year: 2024 },
  ],
  candidate_skills: ["JavaScript", "TypeScript"],
  candidate_languages: ["Arabic (Native)", "English (Fluent)"],
};

const mockEvaluation = {
  candidate_name: "Noura Al-Sabah",
  staff_name: "Dr. Faisal Al-Rashid",
  department: "Engineering",
  start_date: "2026-01-15",
  end_date: "2026-06-15",
  score: 85,
  answers: [
    { question: "Technical Skills", answer: "Excellent", rating: 4 },
    { question: "Communication", answer: "Clear", rating: 5 },
  ],
};

const mockFulltimer = {
  fulltimer_name: "Khalid Al-Otaibi",
  fulltimer_email: "khalid@example.com",
  fulltimer_phone: "965-98765432",
  position: "Senior Engineer",
  start_date: "2026-07-01",
  salary: "1,800 KWD/month",
};

const mockBankAdvice = {
  serial_no: 1024,
  beneficiary_name: "Ahmed Al-Mutairi",
  beneficiary_iban: "KW80CBKU000101201234567101",
  amount: "2,450.500 KWD",
  transfer_date: "2026-06-21",
  company_name: "StudentHub Co.",
};

describe("generateCandidateCvPdf", () => {
  it("returns a non-empty buffer starting with PDF header", async () => {
    const buf = await generateCandidateCvPdf(mockCandidate);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(200);
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
  });

  it("handles minimal data gracefully", async () => {
    const buf = await generateCandidateCvPdf({ candidate_name: "Minimal User" });
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(200);
  });
});

describe("generateEvaluationPdf", () => {
  it("returns a valid PDF buffer", async () => {
    const buf = await generateEvaluationPdf(mockEvaluation);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(200);
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
  });
});

describe("generateOfferLetterPdf", () => {
  it("returns a valid PDF buffer", async () => {
    const buf = await generateOfferLetterPdf(mockFulltimer);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(200);
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
  });
});

describe("generateBankAdvicePdf", () => {
  it("returns a valid PDF buffer", async () => {
    const buf = await generateBankAdvicePdf(mockBankAdvice);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(200);
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
  });
});
