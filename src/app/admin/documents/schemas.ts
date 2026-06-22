import { z } from "zod";

/**
 * Validates a candidate ID for CV PDF download.
 * Accepts a positive integer or numeric string.
 */
export const cvDownloadSchema = z.object({
  candidateId: z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === "string" ? Number(v) : v))
    .pipe(z.number().int().positive("Candidate ID must be a positive integer")),
});

/**
 * Schema for certificate download — requires candidateId + certificate UUID.
 */
export const certificateDownloadSchema = z.object({
  candidateId: z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === "string" ? Number(v) : v))
    .pipe(z.number().int().positive("Candidate ID must be a positive integer")),
  certificateUuid: z.string().uuid("Must be a valid UUID"),
});

/**
 * Validates a UUID for evaluation report or offer letter download.
 */
export const uuidDownloadSchema = z.object({
  uuid: z.string().uuid("Must be a valid UUID"),
});

/**
 * Result type for document download validation.
 */
export const downloadUrlResultSchema = z.object({
  url: z.string(),
  filename: z.string(),
});

export type CvDownloadInput = z.input<typeof cvDownloadSchema>;
export type UuidDownloadInput = z.input<typeof uuidDownloadSchema>;
export type CertificateDownloadInput = z.input<typeof certificateDownloadSchema>;
export type DownloadUrlResult = z.output<typeof downloadUrlResultSchema>;

/**
 * Builds a download URL for a candidate CV PDF.
 */
export function buildCvDownloadUrl(candidateId: number): string {
  return `/api/candidates/${candidateId}/cv/pdf?format=pdf`;
}

/**
 * Builds a download URL for an evaluation report PDF.
 */
export function buildEvaluationDownloadUrl(uuid: string): string {
  return `/api/evaluations/${uuid}/pdf?format=pdf`;
}

/**
 * Builds a download URL for an offer letter PDF.
 */
export function buildOfferLetterDownloadUrl(uuid: string): string {
  return `/api/fulltimers/${uuid}/offer-letter/pdf?format=pdf`;
}

/**
 * Builds a download URL for a bank advice PDF.
 */
export function buildBankAdviceDownloadUrl(uuid: string): string {
  return `/api/transfers/bank-advice/${uuid}/pdf?format=pdf`;
}

/**
 * Builds a download URL for a candidate civil ID card PDF.
 */
export function buildIdCardDownloadUrl(candidateId: number): string {
  return `/api/candidates/${candidateId}/id-card/pdf?format=pdf`;
}

/**
 * Builds a download URL for a candidate certificate PDF.
 */
export function buildCertificateDownloadUrl(candidateId: number, certificateUuid: string): string {
  return `/api/candidates/${candidateId}/certificates/${certificateUuid}/pdf?format=pdf`;
}

/**
 * Validates and builds a download URL for a candidate's CV PDF.
 */
export function validateAndBuildCvUrl(input: CvDownloadInput): DownloadUrlResult {
  const parsed = cvDownloadSchema.parse(input);
  return {
    url: buildCvDownloadUrl(parsed.candidateId),
    filename: `cv-candidate-${parsed.candidateId}.pdf`,
  };
}

/**
 * Validates and builds a download URL for an evaluation report PDF.
 */
export function validateAndBuildEvaluationUrl(input: UuidDownloadInput): DownloadUrlResult {
  const parsed = uuidDownloadSchema.parse(input);
  return {
    url: buildEvaluationDownloadUrl(parsed.uuid),
    filename: `evaluation-report-${parsed.uuid.slice(0, 12)}.pdf`,
  };
}

/**
 * Validates and builds a download URL for an offer letter PDF.
 */
export function validateAndBuildOfferLetterUrl(input: UuidDownloadInput): DownloadUrlResult {
  const parsed = uuidDownloadSchema.parse(input);
  return {
    url: buildOfferLetterDownloadUrl(parsed.uuid),
    filename: `offer-letter-${parsed.uuid.slice(0, 12)}.pdf`,
  };
}

/**
 * Validates and builds a download URL for a candidate civil ID card PDF.
 */
export function validateAndBuildIdCardUrl(input: CvDownloadInput): DownloadUrlResult {
  const parsed = cvDownloadSchema.parse(input);
  return {
    url: buildIdCardDownloadUrl(parsed.candidateId),
    filename: `id-card-${parsed.candidateId}.pdf`,
  };
}

/**
 * Validates and builds a download URL for a candidate certificate PDF.
 */
export function validateAndBuildCertificateUrl(input: CertificateDownloadInput): DownloadUrlResult {
  const parsed = certificateDownloadSchema.parse(input);
  return {
    url: buildCertificateDownloadUrl(parsed.candidateId, parsed.certificateUuid),
    filename: `certificate-${parsed.certificateUuid.slice(0, 12)}.pdf`,
  };
}
