"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/modules/auth/session";
import {
  universityListItemSchema,
  listUniversitiesResultSchema,
  universityIdResultSchema,
} from "./schemas";
import type {
  UniversityListItem,
  ListUniversitiesResult,
  UniversityIdResult,
} from "./schemas";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function logOutputError(source: string, error: unknown): Promise<void> {
  console.error(`[modules/admin/university] ${source} output failed:`, error);
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const listUniversitiesSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  search: z.string().optional(),
});

const getUniversitySchema = z.object({
  universityId: z.coerce.number().int().positive("University ID is required"),
});

const createUniversitySchema = z.object({
  university_name_en: z
    .string()
    .min(1, "English name is required")
    .max(100, "English name must be at most 100 characters"),
  university_name_ar: z
    .string()
    .max(100, "Arabic name must be at most 100 characters")
    .optional()
    .default(""),
  university_data_source: z.coerce.number().int().optional(),
});

const updateUniversitySchema = z.object({
  university_id: z.coerce.number().int().positive(),
  university_name_en: z
    .string()
    .min(1)
    .max(100)
    .optional(),
  university_name_ar: z
    .string()
    .max(100)
    .optional(),
  university_data_source: z.coerce.number().int().optional(),
});

const deleteUniversitySchema = z.object({
  university_id: z.coerce.number().int().positive(),
});

// ---------------------------------------------------------------------------
// listUniversities
// ---------------------------------------------------------------------------

/**
 * List universities with pagination and optional search.
 */
export async function listUniversities(
  params: FormData | z.input<typeof listUniversitiesSchema> = {},
): Promise<ListUniversitiesResult> {
  await requireCapability("admin.system");

  const raw =
    params instanceof FormData
      ? {
          page: params.get("page"),
          limit: params.get("limit"),
          search: params.get("search"),
        }
      : params;

  const parsed = listUniversitiesSchema.safeParse(raw);
  if (!parsed.success) {
    return { records: [], total: 0, page: 1, limit: 20, totalPages: 0 };
  }

  const { page, limit, search } = parsed.data;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { deleted: 0 };
  if (search) {
    where.OR = [
      { university_name_en: { contains: search } },
      { university_name_ar: { contains: search } },
    ];
  }

  const [records, total] = await Promise.all([
    prisma.university.findMany({
      where: where as any,
      orderBy: [{ university_name_en: "asc" }],
      skip,
      take: limit,
      include: {
        _count: { select: { candidate: true } },
      },
    }),
    prisma.university.count({ where: where as any }),
  ]);

  const result: ListUniversitiesResult = {
    records: records.map((r: any): UniversityListItem => ({
      university_id: r.university_id,
      university_name_en: r.university_name_en ?? null,
      university_name_ar: r.university_name_ar ?? null,
      university_data_source: r.university_data_source ?? null,
      candidate_count: r._count?.candidate ?? 0,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };

  // Validate output shape
  const outputParsed = listUniversitiesResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("listUniversities", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// getUniversity
// ---------------------------------------------------------------------------

/**
 * Get a single university by ID.
 * Returns null if not found.
 */
export async function getUniversity(
  universityId: number,
): Promise<UniversityListItem | null> {
  await requireCapability("admin.system");

  const parsed = getUniversitySchema.safeParse({ universityId });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid university ID");
  }

  const record = await prisma.university.findFirst({
    where: { university_id: parsed.data.universityId, deleted: 0 },
    include: {
      _count: { select: { candidate: true } },
    },
  });

  if (!record) return null;

  const raw = record as any;
  const result: UniversityListItem = {
    university_id: raw.university_id,
    university_name_en: raw.university_name_en ?? null,
    university_name_ar: raw.university_name_ar ?? null,
    university_data_source: raw.university_data_source ?? null,
    candidate_count: raw._count?.candidate ?? 0,
  };

  const outputParsed = universityListItemSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("getUniversity", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// createUniversity
// ---------------------------------------------------------------------------

/**
 * Create a new university record.
 */
export async function createUniversity(
  data: z.input<typeof createUniversitySchema>,
): Promise<UniversityIdResult> {
  await requireCapability("admin.system");

  const parsed = createUniversitySchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid university data");
  }

  const { university_name_en, university_name_ar, university_data_source } = parsed.data;

  const record = await prisma.university.create({
    data: {
      university_name_en,
      university_name_ar: university_name_ar || null,
      university_data_source: university_data_source ?? null,
      university_created_at: new Date(),
      university_updated_at: new Date(),
    } as any,
  });

  revalidatePath("/admin/university");
  const result: UniversityIdResult = { university_id: record.university_id };

  const outputParsed = universityIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("createUniversity", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// updateUniversity
// ---------------------------------------------------------------------------

/**
 * Update an existing university record.
 * Throws an error if the record does not exist.
 */
export async function updateUniversity(
  data: z.input<typeof updateUniversitySchema>,
): Promise<UniversityIdResult> {
  await requireCapability("admin.system");

  const parsed = updateUniversitySchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid university data");
  }

  const { university_id, university_name_en, university_name_ar, university_data_source } =
    parsed.data;

  // Verify the record exists
  const existing = await prisma.university.findFirst({
    where: { university_id, deleted: 0 },
  });
  if (!existing) {
    throw new Error(`University record not found: ${university_id}`);
  }

  const updateData: Record<string, unknown> = {
    university_updated_at: new Date(),
  };
  if (university_name_en !== undefined) updateData.university_name_en = university_name_en;
  if (university_name_ar !== undefined) updateData.university_name_ar = university_name_ar || null;
  if (university_data_source !== undefined) updateData.university_data_source = university_data_source;

  await prisma.university.update({
    where: { university_id },
    data: updateData as any,
  });

  revalidatePath("/admin/university");
  const result: UniversityIdResult = { university_id };

  const outputParsed = universityIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("updateUniversity", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// deleteUniversity
// ---------------------------------------------------------------------------

/**
 * Soft-delete a university record by setting deleted=1.
 * Throws an error if the record does not exist.
 */
export async function deleteUniversity(
  universityId: number,
): Promise<UniversityIdResult> {
  await requireCapability("admin.system");

  const parsed = deleteUniversitySchema.safeParse({ university_id: universityId });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid university ID");
  }

  // Verify the record exists
  const existing = await prisma.university.findFirst({
    where: { university_id: parsed.data.university_id, deleted: 0 },
  });
  if (!existing) {
    throw new Error(`University record not found: ${universityId}`);
  }

  // Soft delete
  await prisma.university.update({
    where: { university_id: parsed.data.university_id },
    data: { deleted: 1 } as any,
  });

  revalidatePath("/admin/university");
  const result: UniversityIdResult = { university_id: parsed.data.university_id };

  const outputParsed = universityIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("deleteUniversity", outputParsed.error.issues);
  }

  return result;
}
