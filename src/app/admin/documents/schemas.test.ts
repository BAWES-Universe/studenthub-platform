import { describe, it, expect } from "vitest";
import {
  cvDownloadSchema,
  uuidDownloadSchema,
  buildCvDownloadUrl,
  buildEvaluationDownloadUrl,
  buildOfferLetterDownloadUrl,
  buildBankAdviceDownloadUrl,
  validateAndBuildCvUrl,
  validateAndBuildEvaluationUrl,
  validateAndBuildOfferLetterUrl,
  buildIdCardDownloadUrl,
  buildCertificateDownloadUrl,
  certificateDownloadSchema,
  validateAndBuildIdCardUrl,
  validateAndBuildCertificateUrl,
} from "./schemas";

/**
 * Data-contract tests for admin/documents page.
 *
 * Verifies schema validation and URL construction for:
 * - CV PDF download (candidate ID input)
 * - Evaluation report PDF download (UUID input)
 * - Offer letter PDF download (UUID input)
 */

describe("admin documents — CV download schema", () => {
  it("accepts numeric candidate ID as number", () => {
    const r = cvDownloadSchema.safeParse({ candidateId: 123 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.candidateId).toBe(123);
    }
  });

  it("accepts numeric candidate ID as string", () => {
    const r = cvDownloadSchema.safeParse({ candidateId: "456" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.candidateId).toBe(456);
    }
  });

  it("rejects non-numeric candidate ID", () => {
    const r = cvDownloadSchema.safeParse({ candidateId: "abc" });
    expect(r.success).toBe(false);
  });

  it("rejects zero candidate ID", () => {
    const r = cvDownloadSchema.safeParse({ candidateId: 0 });
    expect(r.success).toBe(false);
  });

  it("rejects negative candidate ID", () => {
    const r = cvDownloadSchema.safeParse({ candidateId: -5 });
    expect(r.success).toBe(false);
  });

  it("rejects empty string candidate ID", () => {
    const r = cvDownloadSchema.safeParse({ candidateId: "" });
    expect(r.success).toBe(false);
  });
});

describe("admin documents — UUID download schema", () => {
  it("accepts valid UUID", () => {
    const r = uuidDownloadSchema.safeParse({
      uuid: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.uuid).toBe("550e8400-e29b-41d4-a716-446655440000");
    }
  });

  it("rejects invalid UUID string", () => {
    const r = uuidDownloadSchema.safeParse({ uuid: "not-a-uuid" });
    expect(r.success).toBe(false);
  });

  it("rejects empty UUID", () => {
    const r = uuidDownloadSchema.safeParse({ uuid: "" });
    expect(r.success).toBe(false);
  });

  it("rejects partial UUID", () => {
    const r = uuidDownloadSchema.safeParse({ uuid: "550e8400" });
    expect(r.success).toBe(false);
  });
});

describe("admin documents — URL builders", () => {
  it("buildCvDownloadUrl constructs correct URL", () => {
    expect(buildCvDownloadUrl(789)).toBe("/api/candidates/789/cv/pdf?format=pdf");
  });

  it("buildEvaluationDownloadUrl constructs correct URL", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(buildEvaluationDownloadUrl(uuid)).toBe(
      `/api/evaluations/${uuid}/pdf?format=pdf`,
    );
  });

  it("buildOfferLetterDownloadUrl constructs correct URL", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(buildOfferLetterDownloadUrl(uuid)).toBe(
      `/api/fulltimers/${uuid}/offer-letter/pdf?format=pdf`,
    );
  });

  it("buildBankAdviceDownloadUrl constructs correct URL", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(buildBankAdviceDownloadUrl(uuid)).toBe(
      `/api/transfers/bank-advice/${uuid}/pdf?format=pdf`,
    );
  });

  it("buildIdCardDownloadUrl constructs correct URL", () => {
    expect(buildIdCardDownloadUrl(555)).toBe("/api/candidates/555/id-card/pdf?format=pdf");
  });

  it("buildCertificateDownloadUrl constructs correct URL", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(buildCertificateDownloadUrl(555, uuid)).toBe(
      `/api/candidates/555/certificates/${uuid}/pdf?format=pdf`,
    );
  });
});

describe("admin documents — validate and build", () => {
  it("validateAndBuildCvUrl returns URL and filename", () => {
    const result = validateAndBuildCvUrl({ candidateId: 999 });
    expect(result.url).toBe("/api/candidates/999/cv/pdf?format=pdf");
    expect(result.filename).toBe("cv-candidate-999.pdf");
  });

  it("validateAndBuildEvaluationUrl returns URL and filename", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = validateAndBuildEvaluationUrl({ uuid });
    expect(result.url).toBe(`/api/evaluations/${uuid}/pdf?format=pdf`);
    expect(result.filename).toBe("evaluation-report-550e8400-e29.pdf");
  });

  it("validateAndBuildOfferLetterUrl returns URL and filename", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = validateAndBuildOfferLetterUrl({ uuid });
    expect(result.url).toBe(`/api/fulltimers/${uuid}/offer-letter/pdf?format=pdf`);
    expect(result.filename).toBe("offer-letter-550e8400-e29.pdf");
  });

  it("validateAndBuildCvUrl throws on invalid input", () => {
    expect(() => validateAndBuildCvUrl({ candidateId: -1 })).toThrow();
  });

  it("validateAndBuildEvaluationUrl throws on invalid UUID", () => {
    expect(() => validateAndBuildEvaluationUrl({ uuid: "bad" })).toThrow();
  });

  it("validateAndBuildOfferLetterUrl throws on invalid UUID", () => {
    expect(() => validateAndBuildOfferLetterUrl({ uuid: "bad" })).toThrow();
  });

  it("validateAndBuildIdCardUrl returns URL and filename", () => {
    const result = validateAndBuildIdCardUrl({ candidateId: 777 });
    expect(result.url).toBe("/api/candidates/777/id-card/pdf?format=pdf");
    expect(result.filename).toBe("id-card-777.pdf");
  });

  it("validateAndBuildIdCardUrl throws on invalid candidate ID", () => {
    expect(() => validateAndBuildIdCardUrl({ candidateId: -1 })).toThrow();
  });

  it("validateAndBuildCertificateUrl returns URL and filename", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = validateAndBuildCertificateUrl({ candidateId: 777, certificateUuid: uuid });
    expect(result.url).toBe(`/api/candidates/777/certificates/${uuid}/pdf?format=pdf`);
    expect(result.filename).toBe("certificate-550e8400-e29.pdf");
  });

  it("validateAndBuildCertificateUrl throws on invalid candidate ID", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(() => validateAndBuildCertificateUrl({ candidateId: -1, certificateUuid: uuid })).toThrow();
  });

  it("validateAndBuildCertificateUrl throws on invalid UUID", () => {
    expect(() => validateAndBuildCertificateUrl({ candidateId: 777, certificateUuid: "bad" })).toThrow();
  });

  it("certificateDownloadSchema rejects missing fields", () => {
    const r = certificateDownloadSchema.safeParse({ candidateId: 777 });
    expect(r.success).toBe(false);
  });

  it("certificateDownloadSchema rejects empty UUID", () => {
    const r = certificateDownloadSchema.safeParse({ candidateId: 777, certificateUuid: "" });
    expect(r.success).toBe(false);
  });
});
