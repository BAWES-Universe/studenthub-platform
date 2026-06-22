"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/modules/auth/session";
import {
  discountCategoryListItemSchema,
  listDiscountCategoriesResultSchema,
  discountCategoryIdResultSchema,
} from "./schemas";
import type {
  DiscountCategoryListItem,
  ListDiscountCategoriesResult,
  DiscountCategoryIdResult,
} from "./schemas";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function logOutputError(source: string, error: unknown): Promise<void> {
  console.error(`[modules/admin/discount-category] ${source} output failed:`, error);
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const listDiscountCategoriesSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  search: z.string().optional(),
});

const getDiscountCategorySchema = z.object({
  categoryId: z.coerce.number().int().positive("Category ID is required"),
});

const createDiscountCategorySchema = z.object({
  name_en: z
    .string()
    .min(1, "English name is required")
    .max(255, "English name must be at most 255 characters"),
  name_ar: z
    .string()
    .max(255, "Arabic name must be at most 255 characters")
    .optional()
    .default(""),
  image: z
    .string()
    .max(255, "Image URL must be at most 255 characters")
    .optional()
    .default(""),
});

const updateDiscountCategorySchema = z.object({
  category_id: z.coerce.number().int().positive(),
  name_en: z
    .string()
    .min(1, "English name is required")
    .max(255)
    .optional(),
  name_ar: z
    .string()
    .max(255)
    .optional(),
  image: z
    .string()
    .max(255)
    .optional(),
});

const deleteDiscountCategorySchema = z.object({
  category_id: z.coerce.number().int().positive(),
});

// ---------------------------------------------------------------------------
// listDiscountCategories
// ---------------------------------------------------------------------------

/**
 * List discount categories with pagination and optional search.
 */
export async function listDiscountCategories(
  params: FormData | z.input<typeof listDiscountCategoriesSchema> = {},
): Promise<ListDiscountCategoriesResult> {
  await requireCapability("admin.system");

  const raw =
    params instanceof FormData
      ? {
          page: params.get("page"),
          limit: params.get("limit"),
          search: params.get("search"),
        }
      : params;

  const parsed = listDiscountCategoriesSchema.safeParse(raw);
  if (!parsed.success) {
    return { records: [], total: 0, page: 1, limit: 20, totalPages: 0 };
  }

  const { page, limit, search } = parsed.data;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (search) {
    where.OR = [
      { name_en: { contains: search } },
      { name_ar: { contains: search } },
    ];
  }

  const [records, total] = await Promise.all([
    prisma.discount_category.findMany({
      where: where as any,
      orderBy: { name_en: "asc" },
      skip,
      take: limit,
      include: {
        _count: { select: { discount: true } },
      },
    }),
    prisma.discount_category.count({ where: where as any }),
  ]);

  const result: ListDiscountCategoriesResult = {
    records: records.map((r: any): DiscountCategoryListItem => ({
      category_id: r.category_id,
      name_en: r.name_en,
      name_ar: r.name_ar ?? null,
      image: r.image ?? null,
      discount_count: r._count?.discount ?? 0,
      created_at: r.created_at ?? null,
      updated_at: r.updated_at ?? null,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };

  // Validate output shape
  const outputParsed = listDiscountCategoriesResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("listDiscountCategories", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// getDiscountCategory
// ---------------------------------------------------------------------------

/**
 * Get a single discount category by ID.
 * Returns null if not found.
 */
export async function getDiscountCategory(
  categoryId: number,
): Promise<DiscountCategoryListItem | null> {
  await requireCapability("admin.system");

  const parsed = getDiscountCategorySchema.safeParse({ categoryId });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid category ID");
  }

  const record = await prisma.discount_category.findFirst({
    where: { category_id: parsed.data.categoryId },
    include: {
      _count: { select: { discount: true } },
    },
  });

  if (!record) return null;

  const raw = record as any;
  const result: DiscountCategoryListItem = {
    category_id: raw.category_id,
    name_en: raw.name_en,
    name_ar: raw.name_ar ?? null,
    image: raw.image ?? null,
    discount_count: raw._count?.discount ?? 0,
    created_at: raw.created_at ?? null,
    updated_at: raw.updated_at ?? null,
  };

  const outputParsed = discountCategoryListItemSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("getDiscountCategory", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// createDiscountCategory
// ---------------------------------------------------------------------------

/**
 * Create a new discount category record.
 */
export async function createDiscountCategory(
  data: z.input<typeof createDiscountCategorySchema>,
): Promise<DiscountCategoryIdResult> {
  await requireCapability("admin.system");

  const parsed = createDiscountCategorySchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid discount category data");
  }

  const { name_en, name_ar, image } = parsed.data;

  const record = await prisma.discount_category.create({
    data: {
      name_en,
      name_ar: name_ar || null,
      image: image || null,
      created_at: new Date(),
      updated_at: new Date(),
    } as any,
  });

  revalidatePath("/admin/discount-category");
  const result: DiscountCategoryIdResult = { category_id: record.category_id };

  const outputParsed = discountCategoryIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("createDiscountCategory", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// updateDiscountCategory
// ---------------------------------------------------------------------------

/**
 * Update an existing discount category record.
 * Throws an error if the record does not exist.
 */
export async function updateDiscountCategory(
  data: z.input<typeof updateDiscountCategorySchema>,
): Promise<DiscountCategoryIdResult> {
  await requireCapability("admin.system");

  const parsed = updateDiscountCategorySchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid discount category data");
  }

  const { category_id, name_en, name_ar, image } = parsed.data;

  // Verify the record exists
  const existing = await prisma.discount_category.findFirst({
    where: { category_id },
  });
  if (!existing) {
    throw new Error(`Discount category not found: ${category_id}`);
  }

  const updateData: Record<string, unknown> = { updated_at: new Date() };
  if (name_en !== undefined) updateData.name_en = name_en;
  if (name_ar !== undefined) updateData.name_ar = name_ar || null;
  if (image !== undefined) updateData.image = image || null;

  await prisma.discount_category.update({
    where: { category_id },
    data: updateData as any,
  });

  revalidatePath("/admin/discount-category");
  const result: DiscountCategoryIdResult = { category_id };

  const outputParsed = discountCategoryIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("updateDiscountCategory", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// deleteDiscountCategory
// ---------------------------------------------------------------------------

/**
 * Delete a discount category record.
 * Throws an error if the record does not exist.
 */
export async function deleteDiscountCategory(
  category_id: number,
): Promise<DiscountCategoryIdResult> {
  await requireCapability("admin.system");

  const parsed = deleteDiscountCategorySchema.safeParse({ category_id });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid category ID");
  }

  // Verify the record exists
  const existing = await prisma.discount_category.findFirst({
    where: { category_id: parsed.data.category_id },
  });
  if (!existing) {
    throw new Error(`Discount category not found: ${parsed.data.category_id}`);
  }

  await prisma.discount_category.delete({
    where: { category_id: parsed.data.category_id },
  });

  revalidatePath("/admin/discount-category");
  const result: DiscountCategoryIdResult = { category_id: parsed.data.category_id };

  const outputParsed = discountCategoryIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("deleteDiscountCategory", outputParsed.error.issues);
  }

  return result;
}
