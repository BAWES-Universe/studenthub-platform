import { z } from "zod";

// ---------------------------------------------------------------------------
// Output validation schemas
// ---------------------------------------------------------------------------

export const discountCategoryListItemSchema = z.object({
  category_id: z.number().int(),
  name_en: z.string(),
  name_ar: z.string().nullable(),
  image: z.string().nullable(),
  discount_count: z.number().int().nonnegative(),
  created_at: z.date().nullable(),
  updated_at: z.date().nullable(),
});

export const listDiscountCategoriesResultSchema = z.object({
  records: z.array(discountCategoryListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
});

export const discountCategoryDetailSchema = discountCategoryListItemSchema;

export const discountCategoryIdResultSchema = z.object({
  category_id: z.number().int(),
});

// ---------------------------------------------------------------------------
// Types derived from output schemas
// ---------------------------------------------------------------------------

export type DiscountCategoryListItem = z.output<typeof discountCategoryListItemSchema>;
export type ListDiscountCategoriesResult = z.output<typeof listDiscountCategoriesResultSchema>;
export type DiscountCategoryDetail = z.output<typeof discountCategoryDetailSchema>;
export type DiscountCategoryIdResult = z.output<typeof discountCategoryIdResultSchema>;
