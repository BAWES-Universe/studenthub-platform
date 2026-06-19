"use server";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCapability, requireRoleCapability } from "@/modules/auth/session";
import {
  candidateErrorResultSchema,
  profileStateSchema,
  languageStateSchema,
  educationStateSchema,
  numericOptionSchema,
  stringIdOptionSchema,
} from "./schemas";
import type {
  ProfileState,
  LanguageState,
  EducationState,
} from "./schemas";

// Re-export types for external consumers (CandidateEditForm, etc.)
export type { ProfileState, LanguageState, EducationState };

// ---------------------------------------------------------------------------
// Profile edit
// ---------------------------------------------------------------------------

const profileSchema = z.object({
  name: z.string().min(1, "Name is required"),
  nameAr: z.string().optional().default(""),
  email: z.union([z.string().email("Invalid email address"), z.literal("")]).optional().default(""),
  phone: z.string().optional().default(""),
  objective: z.string().optional().default(""),
  intro: z.string().optional().default(""),
  civilId: z.string().optional().default(""),
  profileUrl: z.union([z.string().url("Invalid URL"), z.literal("")]).optional().default(""),
  countryId: z.string().optional().default(""),
  universityId: z.string().optional().default(""),
  bankId: z.string().optional().default(""),
  bankAccountName: z.string().optional().default(""),
  iban: z.string().optional().default(""),
  birthDate: z.string().optional().default(""),
  address: z.string().optional().default(""),
});

export async function updateCandidateProfile(
  _prevState: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const session = await requireRoleCapability("candidate", "candidate.read.own");
  const candidateId = Number(session.id);

  const raw = {
    name: (formData.get("name") ?? "") as string,
    nameAr: (formData.get("nameAr") ?? "") as string,
    email: (formData.get("email") ?? "") as string,
    phone: (formData.get("phone") ?? "") as string,
    objective: (formData.get("objective") ?? "") as string,
    intro: (formData.get("intro") ?? "") as string,
    civilId: (formData.get("civilId") ?? "") as string,
    profileUrl: (formData.get("profileUrl") ?? "") as string,
    countryId: (formData.get("countryId") ?? "") as string,
    universityId: (formData.get("universityId") ?? "") as string,
    bankId: (formData.get("bankId") ?? "") as string,
    bankAccountName: (formData.get("bankAccountName") ?? "") as string,
    iban: (formData.get("iban") ?? "") as string,
    birthDate: (formData.get("birthDate") ?? "") as string,
    address: (formData.get("address") ?? "") as string,
  };

  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const d = parsed.data;

  await prisma.candidate.update({
    where: { candidate_id: candidateId },
    data: {
      candidate_name: d.name.trim(),
      candidate_name_ar: d.nameAr || undefined,
      candidate_email: d.email,
      candidate_phone: d.phone || undefined,
      candidate_objective: d.objective || undefined,
      candidate_intro: d.intro || undefined,
      candidate_civil_id: d.civilId || undefined,
      profile_url: d.profileUrl || undefined,
      candidate_address_line1: d.address || undefined,
      country_id: d.countryId ? Number(d.countryId) : null,
      university_id: d.universityId ? Number(d.universityId) : null,
      bank_id: d.bankId ? Number(d.bankId) : null,
      bank_account_name: d.bankAccountName || undefined,
      candidate_iban: d.iban || undefined,
      candidate_birth_date: d.birthDate
        ? (() => {
            const date = new Date(d.birthDate);
            return isFinite(date.getTime()) ? date : undefined;
          })()
        : undefined,
    },
  });

  revalidatePath("/candidate");
  revalidatePath("/candidate/edit");

  const profileResult = { success: true };
  const profileParsed = profileStateSchema.safeParse(profileResult);
  if (!profileParsed.success) {
    console.error(
      "[modules/candidates] updateCandidateProfile output validation failed:",
      profileParsed.error.issues,
    );
  }

  return profileResult;
}

// ---------------------------------------------------------------------------
// Document upload
// ---------------------------------------------------------------------------

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "candidates");

const ALLOWED_TYPES: Record<string, { mime: string[]; ext: string[]; maxSize: number }> = {
  photo: {
    mime: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    ext: [".jpg", ".jpeg", ".png", ".webp", ".gif"],
    maxSize: 5 * 1024 * 1024, // 5 MB
  },
  cv: {
    mime: ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ext: [".pdf", ".doc", ".docx"],
    maxSize: 10 * 1024 * 1024, // 10 MB
  },
  video: {
    mime: ["video/mp4", "video/webm", "video/ogg", "video/quicktime"],
    ext: [".mp4", ".webm", ".ogv", ".mov"],
    maxSize: 50 * 1024 * 1024, // 50 MB
  },
  civilFront: {
    mime: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    ext: [".jpg", ".jpeg", ".png", ".webp", ".gif"],
    maxSize: 5 * 1024 * 1024,
  },
  civilBack: {
    mime: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    ext: [".jpg", ".jpeg", ".png", ".webp", ".gif"],
    maxSize: 5 * 1024 * 1024,
  },
};

async function saveUpload(candidateId: number, field: string, file: File, typeConfig: typeof ALLOWED_TYPES[string]): Promise<string> {
  const ext = path.extname(file.name).toLowerCase();
  if (!typeConfig.ext.includes(ext)) {
    throw new Error(`File type "${ext}" is not allowed for this document type.`);
  }

  if (file.size > typeConfig.maxSize) {
    throw new Error(`File is too large. Maximum size is ${typeConfig.maxSize / 1024 / 1024} MB.`);
  }

  const dir = path.join(UPLOAD_DIR, String(candidateId));
  await fs.mkdir(dir, { recursive: true });

  const filename = `${field}_${crypto.randomUUID()}${ext}`;
  const filepath = path.join(dir, filename);

  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(filepath, buffer);

  return `/uploads/candidates/${candidateId}/${filename}`;
}

export async function uploadDocument(_prevState: { error: string }, formData: FormData) {
  const session = await requireRoleCapability("candidate", "candidate.read.own");
  const candidateId = Number(session.id);

  const allowed = ["photo", "cv", "video", "civilFront", "civilBack"];
  let type = "";
  let file: File | null = null;
  for (const t of allowed) {
    const f = formData.get(`file_${t}`);
    if (f instanceof File && f.size > 0) {
      type = t;
      file = f;
      break;
    }
  }

  if (!file || file.size === 0) {
    return { error: "Please select a file to upload." };
  }

  const typeConfig = ALLOWED_TYPES[type];
  if (file.type && !typeConfig.mime.includes(file.type)) {
    if (type === "cv") return { error: "Invalid file type for CV. Accepted: PDF, DOC, DOCX." };
    if (type === "video") return { error: "Invalid file type for video. Accepted: MP4, WebM, OGG, MOV." };
    return { error: `Invalid file type for ${type}. Accepted image formats.` };
  }

  if (file.size > typeConfig.maxSize) {
    return { error: `File is too large. Maximum size is ${typeConfig.maxSize / 1024 / 1024} MB.` };
  }

  try {
    const path_ = await saveUpload(candidateId, type, file, typeConfig);

    const fieldMap: Record<string, Record<string, unknown>> = {
      photo: { candidate_personal_photo: path_ },
      cv: { candidate_resume: path_ },
      video: { candidate_video: path_ },
      civilFront: { candidate_civil_photo_front: path_ },
      civilBack: { candidate_civil_photo_back: path_ },
    };

    await prisma.candidate.update({
      where: { candidate_id: candidateId },
      data: fieldMap[type],
    });

    revalidatePath("/candidate");
    revalidatePath("/candidate/edit");

    const uploadResult = { error: "" };
    const uploadParsed = candidateErrorResultSchema.safeParse(uploadResult);
    if (!uploadParsed.success) {
      console.error("[modules/candidates] uploadDocument output validation failed:", uploadParsed.error.issues);
    }

    return uploadResult;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Upload failed." };
  }
}

// ---------------------------------------------------------------------------
// Invitation accept / reject
// ---------------------------------------------------------------------------

const INVITATION_STATUS_ACCEPTED = 1;
const INVITATION_STATUS_REJECTED = 2;

export async function respondToInvitation(_prevState: { error: string }, formData: FormData) {
  const session = await requireRoleCapability("candidate", "candidate.read.own");
  const candidateId = Number(session.id);

  const invitationUuid = String(formData.get("invitationUuid") ?? "");
  const action = String(formData.get("action") ?? ""); // "accept" | "reject"

  if (!invitationUuid) {
    return { error: "Missing invitation identifier." };
  }

  if (action !== "accept" && action !== "reject") {
    return { error: "Invalid action." };
  }

  const invitation = await prisma.invitation.findFirst({
    where: { invitation_uuid: invitationUuid, candidate_id: candidateId },
    select: { invitation_uuid: true },
  });

  if (!invitation) {
    return { error: "Invitation not found." };
  }

  const newStatus = action === "accept" ? INVITATION_STATUS_ACCEPTED : INVITATION_STATUS_REJECTED;

  await prisma.invitation.update({
    where: { invitation_uuid: invitationUuid },
    data: {
      invitation_status: newStatus,
      invitation_app_seen_at: new Date(),
      invitation_updated_at: new Date(),
    },
  });

  revalidatePath("/candidate/invitations");
  revalidatePath(`/candidate/invitations/${invitationUuid}`);
  redirect(`/candidate/invitations/${invitationUuid}`);
}

// ---------------------------------------------------------------------------
// Work-log appeal
// ---------------------------------------------------------------------------

export async function appealWorkLog(_prevState: { error: string }, formData: FormData) {
  const session = await requireRoleCapability("candidate", "candidate.read.own");
  const candidateId = Number(session.id);

  const workLogUuid = String(formData.get("workLogUuid") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();

  if (!workLogUuid) {
    return { error: "Missing work-log identifier." };
  }

  if (!reason) {
    return { error: "Please provide a reason for the appeal." };
  }

  const workLog = await prisma.candidate_working_hour.findFirst({
    where: { candidate_working_hour_uuid: workLogUuid, candidate_id: candidateId },
    select: { candidate_working_hour_uuid: true },
  });

  if (!workLog) {
    return { error: "Work log not found." };
  }

  const appealUuid = `appeal_${crypto.randomUUID()}`;
  const now = new Date();

  await prisma.$transaction([
    prisma.candidate_working_hour_appeal.create({
      data: {
        appeal_uuid: appealUuid,
        candidate_working_hour_uuid: workLogUuid,
        candidate_id: candidateId,
        reason,
        status: 0,
        created_at: now,
        updated_at: now,
      },
    }),
    prisma.candidate_working_hour.update({
      where: { candidate_working_hour_uuid: workLogUuid },
      data: { appeal_uuid: appealUuid },
    }),
  ]);

  revalidatePath("/candidate/work-logs");
  revalidatePath(`/candidate/work-logs/${workLogUuid}`);
  redirect(`/candidate/work-logs/${workLogUuid}`);
}

// ---------------------------------------------------------------------------
// Lookup helpers (not server actions — plain async functions for pages)
// ---------------------------------------------------------------------------

export async function getCountryOptions() {
  const rows = await prisma.country.findMany({
    orderBy: { country_name_en: "asc" },
    select: { country_id: true, country_name_en: true, country_nationality_name_en: true },
    take: 250,
  });
  const result = rows.map((r) => ({
    id: r.country_id,
    label: `${r.country_name_en}${r.country_nationality_name_en && r.country_nationality_name_en !== r.country_name_en ? ` (${r.country_nationality_name_en})` : ""}`,
  }));
  const outputParsed = z.array(numericOptionSchema).safeParse(result);
  if (!outputParsed.success) {
    console.error("[modules/candidates] getCountryOptions output validation failed:", outputParsed.error.issues);
  }
  return result;
}

export async function getUniversityOptions() {
  const rows = await prisma.university.findMany({
    where: { deleted: 0 },
    orderBy: { university_name_en: "asc" },
    select: { university_id: true, university_name_en: true },
    take: 250,
  });
  const result = rows.map((r) => ({
    id: r.university_id,
    label: r.university_name_en ?? `University #${r.university_id}`,
  }));
  const outputParsed = z.array(numericOptionSchema).safeParse(result);
  if (!outputParsed.success) {
    console.error("[modules/candidates] getUniversityOptions output validation failed:", outputParsed.error.issues);
  }
  return result;
}

export async function getBankOptions() {
  const rows = await prisma.bank.findMany({
    where: { deleted: 0 },
    orderBy: { bank_name: "asc" },
    select: { bank_id: true, bank_name: true },
    take: 100,
  });
  const result = rows.map((r) => ({
    id: r.bank_id,
    label: r.bank_name ?? `Bank #${r.bank_id}`,
  }));
  const outputParsed = z.array(numericOptionSchema).safeParse(result);
  if (!outputParsed.success) {
    console.error("[modules/candidates] getBankOptions output validation failed:", outputParsed.error.issues);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Skills CRUD
// ---------------------------------------------------------------------------

export async function addCandidateSkill(_prevState: { error: string }, formData: FormData) {
  const session = await requireRoleCapability("candidate", "candidate.read.own");
  const candidateId = Number(session.id);

  const skill = String(formData.get("skill") ?? "").trim();
  if (!skill) return { error: "Skill name is required." };

  await prisma.candidate_skill.create({
    data: {
      candidate_id: candidateId,
      skill,
      candidate_skill_created_at: new Date(),
      deleted: 0,
    },
  });

  revalidatePath("/candidate");
  revalidatePath("/candidate/edit");
  return { error: "" };
}

export async function removeCandidateSkill(_prevState: { error: string }, formData: FormData) {
  const session = await requireRoleCapability("candidate", "candidate.read.own");
  const candidateId = Number(session.id);

  const skillId = Number(formData.get("skillId"));
  if (!Number.isInteger(skillId) || skillId <= 0) return { error: "Invalid skill identifier." };

  const row = await prisma.candidate_skill.findFirst({
    where: { candidate_skill_id: skillId, candidate_id: candidateId, deleted: 0 },
    select: { candidate_skill_id: true },
  });

  if (!row) return { error: "Skill not found." };

  await prisma.candidate_skill.update({
    where: { candidate_skill_id: skillId },
    data: { deleted: 1 },
  });

  revalidatePath("/candidate");
  revalidatePath("/candidate/edit");
  return { error: "" };
}

// -- Language CRUD ---------------------------------------------------------

const PROFICIENCY_LEVELS = ["basic", "intermediate", "advanced", "native"] as const;

const languageSchema = z.object({
  language: z.string().min(1, "Language is required").max(128),
  proficiency: z.enum(PROFICIENCY_LEVELS, { required_error: "Proficiency level is required" }),
});

export async function addCandidateLanguage(_prevState: LanguageState, formData: FormData) {
  const session = await requireCapability("candidate.profile.edit");
  const candidateId = Number(session.id);
  const parsed = languageSchema.safeParse({ language: formData.get("language"), proficiency: formData.get("proficiency") });
  if (!parsed.success) {
    const langResult = { success: false, error: parsed.error.errors.map((e) => e.message).join("; ") };
    const langParsed = languageStateSchema.safeParse(langResult);
    if (!langParsed.success) console.error("[modules/candidates] addCandidateLanguage output validation failed:", langParsed.error.issues);
    return langResult;
  }
  await prisma.candidate_language.create({ data: { candidate_id: candidateId, language: parsed.data.language, proficiency: parsed.data.proficiency, deleted: 0 } });
  revalidatePath("/candidate");
  revalidatePath("/candidate/edit");
  const langResult = { success: true };
  const langParsed = languageStateSchema.safeParse(langResult);
  if (!langParsed.success) console.error("[modules/candidates] addCandidateLanguage output validation failed:", langParsed.error.issues);
  return langResult;
}

export async function removeCandidateLanguage(_prevState: LanguageState, formData: FormData) {
  const session = await requireCapability("candidate.profile.edit");
  const candidateId = Number(session.id);
  const languageId = Number(formData.get("languageId"));
  if (!Number.isInteger(languageId) || languageId <= 0) {
    const langRmResult = { success: false, error: "Invalid language ID." };
    const langRmParsed = languageStateSchema.safeParse(langRmResult);
    if (!langRmParsed.success) console.error("[modules/candidates] removeCandidateLanguage output validation failed:", langRmParsed.error.issues);
    return langRmResult;
  }
  const row = await prisma.candidate_language.findFirst({ where: { candidate_language_id: languageId, candidate_id: candidateId, deleted: 0 } });
  if (!row) {
    const langRmResult = { success: false, error: "Language entry not found." };
    const langRmParsed = languageStateSchema.safeParse(langRmResult);
    if (!langRmParsed.success) console.error("[modules/candidates] removeCandidateLanguage output validation failed:", langRmParsed.error.issues);
    return langRmResult;
  }
  await prisma.candidate_language.update({ where: { candidate_language_id: languageId }, data: { deleted: 1 } });
  revalidatePath("/candidate");
  revalidatePath("/candidate/edit");
  const langRmResult = { success: true };
  const langRmParsed = languageStateSchema.safeParse(langRmResult);
  if (!langRmParsed.success) console.error("[modules/candidates] removeCandidateLanguage output validation failed:", langRmParsed.error.issues);
  return langRmResult;
}

// Degree & major lookup helpers
// ---------------------------------------------------------------------------

export async function getDegreeOptions() {
  const rows = await prisma.degree.findMany({
    orderBy: { degree_name_en: "asc" },
    select: { degree_uuid: true, degree_name_en: true },
    take: 250,
  });
  const result = rows.map((r) => ({
    id: r.degree_uuid,
    label: r.degree_name_en,
  }));
  const outputParsed = z.array(stringIdOptionSchema).safeParse(result);
  if (!outputParsed.success) {
    console.error("[modules/candidates] getDegreeOptions output validation failed:", outputParsed.error.issues);
  }
  return result;
}

export async function getMajorOptions() {
  const rows = await prisma.major.findMany({
    orderBy: { major_name_en: "asc" },
    select: { major_uuid: true, major_name_en: true },
    take: 250,
  });
  const result = rows.map((r) => ({
    id: r.major_uuid,
    label: r.major_name_en,
  }));
  const outputParsed = z.array(stringIdOptionSchema).safeParse(result);
  if (!outputParsed.success) {
    console.error("[modules/candidates] getMajorOptions output validation failed:", outputParsed.error.issues);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Work experience CRUD
// ---------------------------------------------------------------------------

export async function addCandidateExperience(_prevState: { error: string }, formData: FormData) {
  const session = await requireRoleCapability("candidate", "candidate.read.own");
  const candidateId = Number(session.id);

  const experience = String(formData.get("experience") ?? "").trim();
  const employer = String(formData.get("employer") ?? "").trim();
  const startYearStr = String(formData.get("startYear") ?? "").trim();
  const endYearStr = String(formData.get("endYear") ?? "").trim();
  const startYear = startYearStr ? parseInt(startYearStr, 10) : NaN;
  const endYear = endYearStr ? parseInt(endYearStr, 10) : NaN;

  if (!experience) return { error: "Job title / experience is required." };

  await prisma.candidate_experience.create({
    data: {
      candidate_id: candidateId,
      experience,
      employer: employer || undefined,
      start_year: Number.isFinite(startYear) ? startYear : undefined,
      end_year: Number.isFinite(endYear) ? endYear : undefined,
      candidate_experience_created_at: new Date(),
      deleted: 0,
    },
  });

  revalidatePath("/candidate");
  revalidatePath("/candidate/edit");
  return { error: "" };
}

export async function removeCandidateExperience(_prevState: { error: string }, formData: FormData) {
  const session = await requireRoleCapability("candidate", "candidate.read.own");
  const candidateId = Number(session.id);

  const experienceId = Number(formData.get("experienceId"));
  if (!Number.isInteger(experienceId) || experienceId <= 0) return { error: "Invalid experience identifier." };

  const row = await prisma.candidate_experience.findFirst({
    where: { candidate_experience_id: experienceId, candidate_id: candidateId, deleted: 0 },
    select: { candidate_experience_id: true },
  });

  if (!row) return { error: "Experience record not found." };

  await prisma.candidate_experience.update({
    where: { candidate_experience_id: experienceId },
    data: { deleted: 1 },
  });

  revalidatePath("/candidate");
  revalidatePath("/candidate/edit");
  return { error: "" };
}

// ---------------------------------------------------------------------------
// Certificate CRUD
// ---------------------------------------------------------------------------

const certificateSchema = z.object({
  certificate_type: z.enum(["true", "false"]).transform((v) => v === "true"),
  start_date: z.string().max(10).optional(),
  end_date: z.string().max(10).optional(),
});

export async function addCandidateCertificate(_prevState: { error: string }, formData: FormData) {
  const session = await requireRoleCapability("candidate", "candidate.read.own");
  const candidateId = Number(session.id);
  const parsed = certificateSchema.safeParse({
    certificate_type: formData.get("certificate_type"),
    start_date: formData.get("start_date") || undefined,
    end_date: formData.get("end_date") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.errors[0]?.message ?? "Validation failed." };
  const { certificate_type, start_date, end_date } = parsed.data;
  const now = new Date();
  await prisma.candidate_certificate.create({
    data: {
      certificate_uuid: `cert_${crypto.randomUUID()}`,
      candidate_id: candidateId,
      certificate_type,
      start_date: start_date ? (isFinite(new Date(start_date).getTime()) ? new Date(start_date) : null) : null,
      end_date: end_date ? (isFinite(new Date(end_date).getTime()) ? new Date(end_date) : null) : null,
      is_deleted: false,
      created_at: now,
      updated_at: now,
    },
  });
  revalidatePath("/candidate");
  revalidatePath("/candidate/edit");
  return { error: "" };
}

export async function removeCandidateCertificate(_prevState: { error: string }, formData: FormData) {
  const session = await requireRoleCapability("candidate", "candidate.read.own");
  const candidateId = Number(session.id);
  const certificateUuid = String(formData.get("certificateUuid") ?? "");
  if (!certificateUuid) return { error: "Missing certificate identifier." };
  const row = await prisma.candidate_certificate.findFirst({
    where: { certificate_uuid: certificateUuid, candidate_id: candidateId, is_deleted: false },
    select: { certificate_uuid: true },
  });
  if (!row) return { error: "Certificate not found." };
  await prisma.candidate_certificate.update({
    where: { certificate_uuid: certificateUuid },
    data: { is_deleted: true, updated_at: new Date() },
  });
  revalidatePath("/candidate");
  revalidatePath("/candidate/edit");
  return { error: "" };
}

// ---------------------------------------------------------------------------
// Education CRUD
// ---------------------------------------------------------------------------

const EDUCATION_SCHEMA = z.object({
  universityId: z.coerce.number().int().positive("University is required."),
  degreeUuid: z.string().optional().default(""),
  majorUuid: z.string().optional().default(""),
  graduationYear: z.union([z.coerce.number().int().min(1950).max(2035), z.literal("")]).optional().default(""),
  isCurrentlyStudying: z.union([z.literal("1"), z.literal("0")]).optional().default("0"),
});

function parseEducationFields(formData: FormData) {
  const state: EducationState = { success: false };

  const raw = {
    universityId: formData.get("universityId") ?? "",
    degreeUuid: String(formData.get("degreeUuid") ?? ""),
    majorUuid: String(formData.get("majorUuid") ?? ""),
    graduationYear: formData.get("graduationYear") ?? "",
    isCurrentlyStudying: formData.get("isCurrentlyStudying") ?? "0",
  };

  const parsed = EDUCATION_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const err = parsed.error.flatten().fieldErrors;
    state.error = err.universityId?.[0] ?? "Invalid education fields.";
    return { state, fields: null };
  }

  const d = parsed.data;
  return {
    state,
    fields: {
      universityId: d.universityId,
      degreeUuid: d.degreeUuid || undefined,
      majorUuid: d.majorUuid || undefined,
      graduationYear: d.graduationYear === "" ? null : d.graduationYear,
      isCurrentlyStudying: d.isCurrentlyStudying === "1",
    },
  };
}

export async function addCandidateEducation(
  _prevState: EducationState,
  formData: FormData,
): Promise<EducationState> {
  const session = await requireRoleCapability("candidate", "candidate.read.own");
  const candidateId = Number(session.id);

  const result = parseEducationFields(formData);
  if (!result.fields) return result.state;

  const f = result.fields;
  const educationUuid = `edu_${crypto.randomUUID()}`;
  const now = new Date();

  await prisma.candidate_education.create({
    data: {
      education_uuid: educationUuid,
      candidate_id: candidateId,
      university_id: f.universityId,
      degree_uuid: f.degreeUuid,
      major_uuid: f.majorUuid,
      graduation_year: f.graduationYear,
      is_currently_studying: f.isCurrentlyStudying,
      created_at: now,
      updated_at: now,
    },
  });

  revalidatePath("/candidate");
  revalidatePath("/candidate/edit");
  const addEduResult = { success: true };
  const addEduParsed = educationStateSchema.safeParse(addEduResult);
  if (!addEduParsed.success) console.error("[modules/candidates] addCandidateEducation output validation failed:", addEduParsed.error.issues);
  return addEduResult;
}

export async function editCandidateEducation(
  _prevState: EducationState,
  formData: FormData,
): Promise<EducationState> {
  const session = await requireRoleCapability("candidate", "candidate.read.own");
  const candidateId = Number(session.id);

  const educationUuid = String(formData.get("educationUuid") ?? "").trim();
  if (!educationUuid) {
    const editEduErr = { success: false, error: "Missing education identifier." };
    const editEduParsed = educationStateSchema.safeParse(editEduErr);
    if (!editEduParsed.success) console.error("[modules/candidates] editCandidateEducation output validation failed:", editEduParsed.error.issues);
    return editEduErr;
  }

  const result = parseEducationFields(formData);
  if (!result.fields) return result.state;

  const existing = await prisma.candidate_education.findFirst({
    where: { education_uuid: educationUuid, candidate_id: candidateId },
    select: { education_uuid: true },
  });
  if (!existing) {
    const editEduErr = { success: false, error: "Education entry not found." };
    const editEduParsed = educationStateSchema.safeParse(editEduErr);
    if (!editEduParsed.success) console.error("[modules/candidates] editCandidateEducation output validation failed:", editEduParsed.error.issues);
    return editEduErr;
  }

  const f = result.fields;
  const newUuid = `edu_${crypto.randomUUID()}`;
  const now = new Date();

  await prisma.$transaction([
    prisma.candidate_education.delete({
      where: { education_uuid: educationUuid },
    }),
    prisma.candidate_education.create({
      data: {
        education_uuid: newUuid,
        candidate_id: candidateId,
        university_id: f.universityId,
        degree_uuid: f.degreeUuid,
        major_uuid: f.majorUuid,
        graduation_year: f.graduationYear,
        is_currently_studying: f.isCurrentlyStudying,
        created_at: now,
        updated_at: now,
      },
    }),
  ]);

  revalidatePath("/candidate");
  revalidatePath("/candidate/edit");
  const editEduOk = { success: true };
  const editEduParsed = educationStateSchema.safeParse(editEduOk);
  if (!editEduParsed.success) console.error("[modules/candidates] editCandidateEducation output validation failed:", editEduParsed.error.issues);
  return editEduOk;
}

export async function removeCandidateEducation(
  _prevState: EducationState,
  formData: FormData,
): Promise<EducationState> {
  const session = await requireRoleCapability("candidate", "candidate.read.own");
  const candidateId = Number(session.id);

  const educationUuid = String(formData.get("educationUuid") ?? "").trim();
  if (!educationUuid) {
    const rmEduErr = { success: false, error: "Missing education identifier." };
    const rmEduParsed = educationStateSchema.safeParse(rmEduErr);
    if (!rmEduParsed.success) console.error("[modules/candidates] removeCandidateEducation output validation failed:", rmEduParsed.error.issues);
    return rmEduErr;
  }

  const row = await prisma.candidate_education.findFirst({
    where: { education_uuid: educationUuid, candidate_id: candidateId },
    select: { education_uuid: true },
  });
  if (!row) {
    const rmEduErr = { success: false, error: "Education entry not found." };
    const rmEduParsed = educationStateSchema.safeParse(rmEduErr);
    if (!rmEduParsed.success) console.error("[modules/candidates] removeCandidateEducation output validation failed:", rmEduParsed.error.issues);
    return rmEduErr;
  }

  await prisma.candidate_education.delete({
    where: { education_uuid: educationUuid },
  });

  revalidatePath("/candidate");
  revalidatePath("/candidate/edit");
  const rmEduOk = { success: true };
  const rmEduParsed = educationStateSchema.safeParse(rmEduOk);
  if (!rmEduParsed.success) console.error("[modules/candidates] removeCandidateEducation output validation failed:", rmEduParsed.error.issues);
  return rmEduOk;
}

// ---------------------------------------------------------------------------
// Staff-side candidate management
// ---------------------------------------------------------------------------

async function ensureStaffCandidateAccess(session: { role: string; id: string }, candidateId: number) {
  if (session.role === "admin") return;
  const staffId = Number(session.id);
  const row = await prisma.candidate_work_history.findFirst({
    where: { candidate_id: candidateId, staff_id: staffId, deleted: false },
    select: { id: true },
  });
  if (!row) throw new Error("Access denied.");
}

function staffBasePath(role: string) {
  return role === "admin" ? "/admin/candidates" : "/staff/candidates";
}

// -- Notes ---------------------------------------------------------------

export async function addStaffCandidateNote(_prevState: { error: string }, formData: FormData) {
  const session = await requireCapability("candidate.search");
  const candidateId = Number(formData.get("candidateId"));
  const noteText = String(formData.get("noteText") ?? "").trim();
  const noteType = String(formData.get("noteType") ?? "Internal Note").trim();

  if (!Number.isInteger(candidateId) || candidateId <= 0) return { error: "Invalid candidate." };
  if (!noteText) return { error: "Note text is required." };

  try { await ensureStaffCandidateAccess(session, candidateId); } catch { return { error: "Access denied." }; }

  const staffId = Number(session.id);
  const now = new Date();
  await prisma.note.create({
    data: {
      note_uuid: `note_${crypto.randomUUID()}`,
      candidate_id: candidateId,
      note_type: noteType,
      note_text: noteText,
      created_by: staffId,
      updated_by: staffId,
      note_created_datetime: now,
      note_updated_datetime: now,
    },
  });

  const base = staffBasePath(session.role);
  revalidatePath(`${base}/${candidateId}`);
  revalidatePath(base);
  return { error: "" };
}

export async function editStaffCandidateNote(_prevState: { error: string }, formData: FormData) {
  const session = await requireCapability("candidate.search");
  const noteUuid = String(formData.get("noteUuid") ?? "");
  const noteText = String(formData.get("noteText") ?? "").trim();

  if (!noteUuid) return { error: "Missing note identifier." };
  if (!noteText) return { error: "Note text is required." };

  const note = await prisma.note.findUnique({
    where: { note_uuid: noteUuid },
    select: { note_uuid: true, candidate_id: true },
  });
  if (!note || !note.candidate_id) return { error: "Note not found." };

  try { await ensureStaffCandidateAccess(session, note.candidate_id); } catch { return { error: "Access denied." }; }

  await prisma.note.update({
    where: { note_uuid: noteUuid },
    data: {
      note_text: noteText,
      updated_by: Number(session.id),
      note_updated_datetime: new Date(),
    },
  });

  const base = staffBasePath(session.role);
  revalidatePath(`${base}/${note.candidate_id}`);
  revalidatePath(base);
  return { error: "" };
}

// -- Tags ----------------------------------------------------------------

export async function addStaffCandidateTag(_prevState: { error: string }, formData: FormData) {
  const session = await requireCapability("candidate.search");
  const candidateId = Number(formData.get("candidateId"));
  const tag = String(formData.get("tag") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  if (!Number.isInteger(candidateId) || candidateId <= 0) return { error: "Invalid candidate." };
  if (!tag) return { error: "Tag is required." };

  try { await ensureStaffCandidateAccess(session, candidateId); } catch { return { error: "Access denied." }; }

  const now = new Date();
  const staffId = Number(session.id);
  await prisma.candidate_tag.create({
    data: {
      candidate_id: candidateId,
      tag,
      reason: reason || undefined,
      created_by: staffId,
      created_at: now,
      updated_at: now,
      deleted: 0,
    },
  });

  const base = staffBasePath(session.role);
  revalidatePath(`${base}/${candidateId}`);
  revalidatePath(base);
  return { error: "" };
}

export async function removeStaffCandidateTag(_prevState: { error: string }, formData: FormData) {
  const session = await requireCapability("candidate.search");
  const tagId = Number(formData.get("tagId"));

  if (!Number.isInteger(tagId) || tagId <= 0) return { error: "Invalid tag identifier." };

  const tag = await prisma.candidate_tag.findFirst({
    where: { tag_id: tagId, deleted: 0 },
    select: { tag_id: true, candidate_id: true },
  });
  if (!tag || !tag.candidate_id) return { error: "Tag not found." };

  try { await ensureStaffCandidateAccess(session, tag.candidate_id); } catch { return { error: "Access denied." }; }

  await prisma.candidate_tag.update({
    where: { tag_id: tagId },
    data: { deleted: 1, updated_at: new Date() },
  });

  const base = staffBasePath(session.role);
  revalidatePath(`${base}/${tag.candidate_id}`);
  revalidatePath(base);
  return { error: "" };
}

// -- Warnings ------------------------------------------------------------

export async function addStaffCandidateWarning(_prevState: { error: string }, formData: FormData) {
  const session = await requireCapability("candidate.search");
  const candidateId = Number(formData.get("candidateId"));
  const title = String(formData.get("title") ?? "Not appearing for interview").trim();
  const message = String(formData.get("message") ?? "").trim();

  if (!Number.isInteger(candidateId) || candidateId <= 0) return { error: "Invalid candidate." };
  if (!message) return { error: "Warning message is required." };

  try { await ensureStaffCandidateAccess(session, candidateId); } catch { return { error: "Access denied." }; }

  const staffId = Number(session.id);
  const now = new Date();
  await prisma.candidate_warning.create({
    data: {
      candidate_id: candidateId,
      title: title || "Not appearing for interview",
      message,
      created_by: staffId,
      updated_by: staffId,
      created_at: now,
      updated_at: now,
    },
  });

  const base = staffBasePath(session.role);
  revalidatePath(`${base}/${candidateId}`);
  revalidatePath(base);
  return { error: "" };
}

export async function removeStaffCandidateWarning(_prevState: { error: string }, formData: FormData) {
  const session = await requireCapability("candidate.search");
  const warningId = Number(formData.get("warningId"));

  if (!Number.isInteger(warningId) || warningId <= 0) return { error: "Invalid warning identifier." };

  const warning = await prisma.candidate_warning.findUnique({
    where: { warning_id: warningId },
    select: { warning_id: true, candidate_id: true },
  });
  if (!warning || !warning.candidate_id) return { error: "Warning not found." };

  try { await ensureStaffCandidateAccess(session, warning.candidate_id); } catch { return { error: "Access denied." }; }

  await prisma.candidate_warning.delete({ where: { warning_id: warningId } });

  const base = staffBasePath(session.role);
  revalidatePath(`${base}/${warning.candidate_id}`);
  revalidatePath(base);
  return { error: "" };
}

// -- Skills (staff-side) ------------------------------------------------

export async function addStaffCandidateSkill(_prevState: { error: string }, formData: FormData) {
  const session = await requireCapability("candidate.search");
  const candidateId = Number(formData.get("candidateId"));
  const skill = String(formData.get("skill") ?? "").trim();

  if (!Number.isInteger(candidateId) || candidateId <= 0) return { error: "Invalid candidate." };
  if (!skill) return { error: "Skill name is required." };

  try { await ensureStaffCandidateAccess(session, candidateId); } catch { return { error: "Access denied." }; }

  await prisma.candidate_skill.create({
    data: {
      candidate_id: candidateId,
      skill,
      candidate_skill_created_at: new Date(),
      deleted: 0,
    },
  });

  const base = staffBasePath(session.role);
  revalidatePath(`${base}/${candidateId}`);
  revalidatePath(base);
  return { error: "" };
}

export async function removeStaffCandidateSkill(_prevState: { error: string }, formData: FormData) {
  const session = await requireCapability("candidate.search");
  const skillId = Number(formData.get("skillId"));

  if (!Number.isInteger(skillId) || skillId <= 0) return { error: "Invalid skill identifier." };

  const row = await prisma.candidate_skill.findFirst({
    where: { candidate_skill_id: skillId, deleted: 0 },
    select: { candidate_skill_id: true, candidate_id: true },
  });
  if (!row || !row.candidate_id) return { error: "Skill not found." };

  try { await ensureStaffCandidateAccess(session, row.candidate_id); } catch { return { error: "Access denied." }; }

  await prisma.candidate_skill.update({
    where: { candidate_skill_id: skillId },
    data: { deleted: 1 },
  });

  const base = staffBasePath(session.role);
  revalidatePath(`${base}/${row.candidate_id}`);
  revalidatePath(base);
  return { error: "" };
}

// -- Status mutations ---------------------------------------------------

export async function setCandidateApproval(_prevState: { error: string }, formData: FormData) {
  const session = await requireCapability("candidate.search");
  const candidateId = Number(formData.get("candidateId"));
  const approved = Number(formData.get("approved"));

  if (!Number.isInteger(candidateId) || candidateId <= 0) return { error: "Invalid candidate." };
  if (approved !== 0 && approved !== 1) return { error: "Approval value must be 0 or 1." };

  try { await ensureStaffCandidateAccess(session, candidateId); } catch { return { error: "Access denied." }; }

  await prisma.candidate.update({
    where: { candidate_id: candidateId },
    data: { approved, candidate_updated_at: new Date() },
  });

  const base = staffBasePath(session.role);
  revalidatePath(`${base}/${candidateId}`);
  revalidatePath(base);
  return { error: "" };
}

export async function setCandidateProfileComplete(_prevState: { error: string }, formData: FormData) {
  const session = await requireCapability("candidate.search");
  const candidateId = Number(formData.get("candidateId"));

  if (!Number.isInteger(candidateId) || candidateId <= 0) return { error: "Invalid candidate." };

  try { await ensureStaffCandidateAccess(session, candidateId); } catch { return { error: "Access denied." }; }

  const candidate = await prisma.candidate.findFirst({
    where: { candidate_id: candidateId, deleted: 0 },
    select: { is_incomplete_profile: true },
  });
  if (!candidate) return { error: "Candidate not found." };

  await prisma.candidate.update({
    where: { candidate_id: candidateId },
    data: { is_incomplete_profile: !candidate.is_incomplete_profile, candidate_updated_at: new Date() },
  });

  const base = staffBasePath(session.role);
  revalidatePath(`${base}/${candidateId}`);
  revalidatePath(base);
  return { error: "" };
}

export async function clearCandidateCivilVerification(_prevState: { error: string }, formData: FormData) {
  const session = await requireCapability("candidate.search");
  const candidateId = Number(formData.get("candidateId"));

  if (!Number.isInteger(candidateId) || candidateId <= 0) return { error: "Invalid candidate." };

  try { await ensureStaffCandidateAccess(session, candidateId); } catch { return { error: "Access denied." }; }

  await prisma.candidate.update({
    where: { candidate_id: candidateId },
    data: { candidate_civil_need_verification: false, candidate_updated_at: new Date() },
  });

  const base = staffBasePath(session.role);
  revalidatePath(`${base}/${candidateId}`);
  revalidatePath(base);
  return { error: "" };
}

// -- ID Request approve/reject -----------------------------------------------

const rejectIdRequestSchema = z.object({
  requestUuid: z.string().min(1, "Request UUID is required."),
  reason: z
    .string()
    .min(10, "Rejection reason must be at least 10 characters.")
    .max(500, "Rejection reason must be under 500 characters."),
});

function parseCandidateIdList(raw: string | null | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(/[^0-9]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
}

export async function approveIdRequest(_prevState: { error: string }, formData: FormData) {
  const session = await requireRoleCapability("inspector", "id_review.mutate");
  const requestUuid = formData.get("requestUuid");

  if (typeof requestUuid !== "string" || !requestUuid.trim()) {
    return { error: "Invalid request." };
  }

  const request = await prisma.candidate_id_request.findUnique({
    where: { cir_uuid: requestUuid },
    select: { cir_uuid: true, status: true, candidate_ids: true },
  });

  if (!request) return { error: "ID request not found." };
  if (request.status !== "pending") return { error: "This request can only be processed from 'pending' status." };

  const staffId = Number(session.id);
  const now = new Date();

  await prisma.candidate_id_request.update({
    where: { cir_uuid: requestUuid },
    data: {
      status: "approved",
      updated_by: staffId,
      updated_at: now,
    },
  });

  const candidateIds = parseCandidateIdList(request.candidate_ids);
  if (candidateIds.length > 0) {
    await prisma.candidate_notification.createMany({
      data: candidateIds.map((candidateId) => ({
        cn_uuid: crypto.randomUUID(),
        candidate_id: candidateId,
        type: 50,
        staff_id: staffId,
        message: "Your ID verification request has been approved.",
        is_new: true,
        created_at: now,
        updated_at: now,
      })),
    });
  }

  revalidatePath(`/inspector/id-requests/${requestUuid}`);
  revalidatePath("/inspector/id-requests");
  redirect(`/inspector/id-requests/${requestUuid}?notice=id-request-approved`);
}

export async function rejectIdRequest(_prevState: { error: string }, formData: FormData) {
  const session = await requireRoleCapability("inspector", "id_review.mutate");
  const requestUuid = formData.get("requestUuid");
  const reason = formData.get("reason");

  const parsed = rejectIdRequestSchema.safeParse({ requestUuid, reason });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const request = await prisma.candidate_id_request.findUnique({
    where: { cir_uuid: parsed.data.requestUuid },
    select: { cir_uuid: true, status: true, candidate_ids: true },
  });

  if (!request) return { error: "ID request not found." };
  if (request.status !== "pending") return { error: "This request can only be processed from 'pending' status." };

  const staffId = Number(session.id);
  const now = new Date();

  await prisma.candidate_id_request.update({
    where: { cir_uuid: parsed.data.requestUuid },
    data: {
      status: "rejected",
      rejection_reason: parsed.data.reason,
      updated_by: staffId,
      updated_at: now,
    },
  });

  const candidateIds = parseCandidateIdList(request.candidate_ids);
  if (candidateIds.length > 0) {
    await prisma.candidate_notification.createMany({
      data: candidateIds.map((candidateId) => ({
        cn_uuid: crypto.randomUUID(),
        candidate_id: candidateId,
        type: 50,
        staff_id: staffId,
        message: `Your ID verification request has been rejected. Reason: ${parsed.data.reason}`,
        is_new: true,
        created_at: now,
        updated_at: now,
      })),
    });
  }

  revalidatePath(`/inspector/id-requests/${requestUuid}`);
  revalidatePath("/inspector/id-requests");
  redirect(`/inspector/id-requests/${requestUuid}?notice=id-request-rejected`);
}
