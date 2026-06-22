import { z } from "zod";

// ---------------------------------------------------------------------------
// Output validation schemas
// ---------------------------------------------------------------------------

export const majorListItemSchema = z.object({
  major_uuid: z.string(),
  major_name_en: z.string(),
  major_name_ar: z.string().nullable(),
  data_source: z.number().int().nullable(),
  major_created_at: z.string().nullable(),
  major_updated_at: z.string().nullable(),
  candidate_count: z.number().int().nullable(),
});

export const listMajorResultSchema = z.object({
  records: z.array(majorListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
});

export const majorIdResultSchema = z.object({
  major_uuid: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Types derived from output schemas
// ---------------------------------------------------------------------------

export type MajorListItem = z.output<typeof majorListItemSchema>;
export type ListMajorResult = z.output<typeof listMajorResultSchema>;
export type MajorIdResult = z.output<typeof majorIdResultSchema>;
