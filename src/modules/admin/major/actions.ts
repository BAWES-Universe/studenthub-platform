"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/modules/auth/session";
import { majorListItemSchema, listMajorResultSchema, majorIdResultSchema } from "./schemas";
import type { MajorListItem, ListMajorResult, MajorIdResult } from "./schemas";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function logOutputError(source: string, error: unknown): Promise<void> {
  console.error(`[modules/admin/major] ${source} output failed:`, error);
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const listMajorsSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  search: z.string().optional(),
});

const getMajorSchema = z.object({
  majorUuid: z.string().min(1, "Major UUID is required"),
});

const createMajorSchema = z.object({
  major_name_en: z
    .string()
    .min(1, "English name is required")
    .max(150, "English name must be at most 150 characters"),
  major_name_ar: z
    .string()
    .min(1, "Arabic name is required")
    .max(150, "Arabic name must be at most 150 characters"),
  data_source: z.coerce.number().int().optional(),
});

const updateMajorSchema = z.object({
  majorUuid: z.string().min(1),
  major_name_en: z.string().min(1).max(150).optional(),
  major_name_ar: z.string().min(1).max(150).optional(),
  data_source: z.coerce.number().int().optional(),
});

const deleteMajorSchema = z.object({
  majorUuid: z.string().min(1),
});

// ---------------------------------------------------------------------------
// listMajors
// ---------------------------------------------------------------------------

/**
 * List majors with pagination and optional search.
 */
export async function listMajors(
  params: FormData | z.input<typeof listMajorsSchema> = {},
): Promise<ListMajorResult> {
  await requireCapability("admin.system");

  const raw =
    params instanceof FormData
      ? {
          page: params.get("page"),
          limit: params.get("limit"),
          search: params.get("search"),
        }
      : params;

  const parsed = listMajorsSchema.safeParse(raw);
  if (!parsed.success) {
    return { records: [], total: 0, page: 1, limit: 20, totalPages: 0 };
  }

  const { page, limit, search } = parsed.data;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (search) {
    where.OR = [
      { major_name_en: { contains: search } },
      { major_name_ar: { contains: search } },
    ];
  }

  const [records, total] = await Promise.all([
    prisma.major.findMany({
      where: where as any,
      orderBy: [{ major_name_en: "asc" }],
      skip,
      take: limit,
      include: {
        _count: { select: { candidate_education: true } },
      },
    }),
    prisma.major.count({ where: where as any }),
  ]);

  const result: ListMajorResult = {
    records: records.map((r: any): MajorListItem => ({
      major_uuid: r.major_uuid,
      major_name_en: r.major_name_en,
      major_name_ar: r.major_name_ar ?? null,
      data_source: r.data_source ?? null,
      major_created_at: r.major_created_at?.toISOString() ?? null,
      major_updated_at: r.major_updated_at?.toISOString() ?? null,
      candidate_count: r._count?.candidate_education ?? 0,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };

  const outputParsed = listMajorResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("listMajors", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// getMajor
// ---------------------------------------------------------------------------

/**
 * Get a single major by UUID.
 * Returns null if not found.
 */
export async function getMajor(
  majorUuid: string,
): Promise<MajorListItem | null> {
  await requireCapability("admin.system");

  const parsed = getMajorSchema.safeParse({ majorUuid });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid major UUID");
  }

  const record = await prisma.major.findFirst({
    where: { major_uuid: parsed.data.majorUuid },
    include: {
      _count: { select: { candidate_education: true } },
    },
  });

  if (!record) return null;

  const raw = record as any;
  const result: MajorListItem = {
    major_uuid: raw.major_uuid,
    major_name_en: raw.major_name_en,
    major_name_ar: raw.major_name_ar ?? null,
    data_source: raw.data_source ?? null,
    major_created_at: raw.major_created_at?.toISOString() ?? null,
    major_updated_at: raw.major_updated_at?.toISOString() ?? null,
    candidate_count: raw._count?.candidate_education ?? 0,
  };

  const outputParsed = majorListItemSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("getMajor", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// createMajor
// ---------------------------------------------------------------------------

/**
 * Create a new major record.
 */
export async function createMajor(
  data: z.input<typeof createMajorSchema>,
): Promise<MajorIdResult> {
  await requireCapability("admin.system");

  const parsed = createMajorSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid major data");
  }

  const { major_name_en, major_name_ar, data_source } = parsed.data;

  const uuid = crypto.randomUUID();

  const record = await prisma.major.create({
    data: {
      major_uuid: uuid,
      major_name_en,
      major_name_ar,
      data_source: data_source ?? null,
      major_created_at: new Date(),
      major_updated_at: new Date(),
    } as any,
  });

  revalidatePath("/admin/major");
  const result: MajorIdResult = { major_uuid: record.major_uuid };

  const outputParsed = majorIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("createMajor", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// updateMajor
// ---------------------------------------------------------------------------

/**
 * Update an existing major record.
 */
export async function updateMajor(
  data: z.input<typeof updateMajorSchema>,
): Promise<MajorIdResult> {
  await requireCapability("admin.system");

  const parsed = updateMajorSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid major data");
  }

  const { majorUuid, major_name_en, major_name_ar, data_source } = parsed.data;

  const existing = await prisma.major.findFirst({
    where: { major_uuid: majorUuid },
  });
  if (!existing) {
    throw new Error(`Major record not found: ${majorUuid}`);
  }

  const updateData: Record<string, unknown> = {
    major_updated_at: new Date(),
  };
  if (major_name_en !== undefined) updateData.major_name_en = major_name_en;
  if (major_name_ar !== undefined) updateData.major_name_ar = major_name_ar;
  if (data_source !== undefined) updateData.data_source = data_source;

  await prisma.major.update({
    where: { major_uuid: majorUuid },
    data: updateData as any,
  });

  revalidatePath("/admin/major");
  const result: MajorIdResult = { major_uuid: majorUuid };

  const outputParsed = majorIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("updateMajor", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// deleteMajor
// ---------------------------------------------------------------------------

/**
 * Delete a major record.
 */
export async function deleteMajor(
  majorUuid: string,
): Promise<MajorIdResult> {
  await requireCapability("admin.system");

  const parsed = deleteMajorSchema.safeParse({ majorUuid });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid major UUID");
  }

  const existing = await prisma.major.findFirst({
    where: { major_uuid: parsed.data.majorUuid },
  });
  if (!existing) {
    throw new Error(`Major record not found: ${parsed.data.majorUuid}`);
  }

  await prisma.major.delete({
    where: { major_uuid: parsed.data.majorUuid },
  });

  revalidatePath("/admin/major");
  const result: MajorIdResult = { major_uuid: parsed.data.majorUuid };

  const outputParsed = majorIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("deleteMajor", outputParsed.error.issues);
  }

  return result;
}
