"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/modules/auth/session";
import {
  degreeGroupListItemSchema,
  listDegreeGroupsResultSchema,
  degreeGroupIdResultSchema,
} from "./schemas";
import type {
  DegreeGroupListItem,
  ListDegreeGroupsResult,
  DegreeGroupIdResult,
} from "./schemas";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function logOutputError(source: string, error: unknown): Promise<void> {
  console.error(`[modules/admin/degree-group] ${source} output failed:`, error);
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const listDegreeGroupsSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  search: z.string().optional(),
});

const getDegreeGroupSchema = z.object({
  degreeGroupUuid: z.string().min(1, "Degree group UUID is required"),
});

const createDegreeGroupSchema = z.object({
  degree_group_name_en: z
    .string()
    .min(1, "English name is required")
    .max(255, "English name must be at most 255 characters"),
  degree_group_name_ar: z
    .string()
    .max(255, "Arabic name must be at most 255 characters")
    .optional()
    .default(""),
  degree_group_sort_order: z.coerce.number().int().optional(),
  skip_major: z.coerce.number().int().optional(),
});

const updateDegreeGroupSchema = z.object({
  degreeGroupUuid: z.string().min(1),
  degree_group_name_en: z
    .string()
    .min(1, "English name is required")
    .max(255)
    .optional(),
  degree_group_name_ar: z
    .string()
    .max(255)
    .optional(),
  degree_group_sort_order: z.coerce.number().int().optional(),
  skip_major: z.coerce.number().int().optional(),
});

const deleteDegreeGroupSchema = z.object({
  degreeGroupUuid: z.string().min(1),
});

// ---------------------------------------------------------------------------
// listDegreeGroups
// ---------------------------------------------------------------------------

/**
 * List degree groups with pagination and optional search.
 */
export async function listDegreeGroups(
  params: FormData | z.input<typeof listDegreeGroupsSchema> = {},
): Promise<ListDegreeGroupsResult> {
  await requireCapability("admin.system");

  const raw =
    params instanceof FormData
      ? {
          page: params.get("page"),
          limit: params.get("limit"),
          search: params.get("search"),
        }
      : params;

  const parsed = listDegreeGroupsSchema.safeParse(raw);
  if (!parsed.success) {
    return { records: [], total: 0, page: 1, limit: 20, totalPages: 0 };
  }

  const { page, limit, search } = parsed.data;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (search) {
    where.OR = [
      { degree_group_name_en: { contains: search } },
      { degree_group_name_ar: { contains: search } },
    ];
  }

  const [records, total] = await Promise.all([
    prisma.degree_group.findMany({
      where: where as any,
      orderBy: [{ degree_group_sort_order: "asc" }, { degree_group_name_en: "asc" }],
      skip,
      take: limit,
      include: {
        _count: { select: { degree: true } },
      },
    }),
    prisma.degree_group.count({ where: where as any }),
  ]);

  const result: ListDegreeGroupsResult = {
    records: records.map((r: any): DegreeGroupListItem => ({
      degree_group_uuid: r.degree_group_uuid,
      degree_group_name_en: r.degree_group_name_en,
      degree_group_name_ar: r.degree_group_name_ar ?? null,
      degree_group_sort_order: r.degree_group_sort_order ?? null,
      skip_major: r.skip_major ?? null,
      degree_count: r._count?.degree ?? 0,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };

  // Validate output shape
  const outputParsed = listDegreeGroupsResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("listDegreeGroups", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// getDegreeGroup
// ---------------------------------------------------------------------------

/**
 * Get a single degree group by UUID.
 * Returns null if not found.
 */
export async function getDegreeGroup(
  degreeGroupUuid: string,
): Promise<DegreeGroupListItem | null> {
  await requireCapability("admin.system");

  const parsed = getDegreeGroupSchema.safeParse({ degreeGroupUuid });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid degree group UUID");
  }

  const record = await prisma.degree_group.findFirst({
    where: { degree_group_uuid: parsed.data.degreeGroupUuid },
    include: {
      _count: { select: { degree: true } },
    },
  });

  if (!record) return null;

  const raw = record as any;
  const result: DegreeGroupListItem = {
    degree_group_uuid: raw.degree_group_uuid,
    degree_group_name_en: raw.degree_group_name_en,
    degree_group_name_ar: raw.degree_group_name_ar ?? null,
    degree_group_sort_order: raw.degree_group_sort_order ?? null,
    skip_major: raw.skip_major ?? null,
    degree_count: raw._count?.degree ?? 0,
  };

  // Validate output shape
  const outputParsed = degreeGroupListItemSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("getDegreeGroup", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// createDegreeGroup
// ---------------------------------------------------------------------------

/**
 * Create a new degree group record.
 */
export async function createDegreeGroup(
  data: z.input<typeof createDegreeGroupSchema>,
): Promise<DegreeGroupIdResult> {
  await requireCapability("admin.system");

  const parsed = createDegreeGroupSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid degree group data");
  }

  const { degree_group_name_en, degree_group_name_ar, degree_group_sort_order, skip_major } =
    parsed.data;

  const uuid = crypto.randomUUID();

  const record = await prisma.degree_group.create({
    data: {
      degree_group_uuid: uuid,
      degree_group_name_en,
      degree_group_name_ar: degree_group_name_ar || null,
      degree_group_sort_order: degree_group_sort_order ?? null,
      skip_major: skip_major ?? null,
      degree_group_created_at: new Date(),
      degree_group_updated_at: new Date(),
    } as any,
  });

  revalidatePath("/admin/degree-group");
  const result: DegreeGroupIdResult = { degree_group_uuid: record.degree_group_uuid };

  const outputParsed = degreeGroupIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("createDegreeGroup", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// updateDegreeGroup
// ---------------------------------------------------------------------------

/**
 * Update an existing degree group record.
 * Throws an error if the record does not exist.
 */
export async function updateDegreeGroup(
  data: z.input<typeof updateDegreeGroupSchema>,
): Promise<DegreeGroupIdResult> {
  await requireCapability("admin.system");

  const parsed = updateDegreeGroupSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid degree group data");
  }

  const {
    degreeGroupUuid,
    degree_group_name_en,
    degree_group_name_ar,
    degree_group_sort_order,
    skip_major,
  } = parsed.data;

  // Verify the record exists
  const existing = await prisma.degree_group.findFirst({
    where: { degree_group_uuid: degreeGroupUuid },
  });
  if (!existing) {
    throw new Error(`Degree group record not found: ${degreeGroupUuid}`);
  }

  const updateData: Record<string, unknown> = {
    degree_group_updated_at: new Date(),
  };
  if (degree_group_name_en !== undefined) updateData.degree_group_name_en = degree_group_name_en;
  if (degree_group_name_ar !== undefined) updateData.degree_group_name_ar = degree_group_name_ar || null;
  if (degree_group_sort_order !== undefined) updateData.degree_group_sort_order = degree_group_sort_order;
  if (skip_major !== undefined) updateData.skip_major = skip_major;

  await prisma.degree_group.update({
    where: { degree_group_uuid: degreeGroupUuid },
    data: updateData as any,
  });

  revalidatePath("/admin/degree-group");
  const result: DegreeGroupIdResult = { degree_group_uuid: degreeGroupUuid };

  const outputParsed = degreeGroupIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("updateDegreeGroup", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// deleteDegreeGroup
// ---------------------------------------------------------------------------

/**
 * Delete a degree group record.
 * Throws an error if the record does not exist.
 */
export async function deleteDegreeGroup(
  degreeGroupUuid: string,
): Promise<DegreeGroupIdResult> {
  await requireCapability("admin.system");

  const parsed = deleteDegreeGroupSchema.safeParse({ degreeGroupUuid });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid degree group UUID");
  }

  // Verify the record exists
  const existing = await prisma.degree_group.findFirst({
    where: { degree_group_uuid: parsed.data.degreeGroupUuid },
  });
  if (!existing) {
    throw new Error(`Degree group record not found: ${parsed.data.degreeGroupUuid}`);
  }

  await prisma.degree_group.delete({
    where: { degree_group_uuid: parsed.data.degreeGroupUuid },
  });

  revalidatePath("/admin/degree-group");
  const result: DegreeGroupIdResult = { degree_group_uuid: parsed.data.degreeGroupUuid };

  const outputParsed = degreeGroupIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("deleteDegreeGroup", outputParsed.error.issues);
  }

  return result;
}
