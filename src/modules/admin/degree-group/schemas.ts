import { z } from "zod";

// ---------------------------------------------------------------------------
// Output validation schemas
// ---------------------------------------------------------------------------

export const degreeGroupListItemSchema = z.object({
  degree_group_uuid: z.string(),
  degree_group_name_en: z.string(),
  degree_group_name_ar: z.string().nullable(),
  degree_group_sort_order: z.number().int().nullable(),
  skip_major: z.number().int().nullable(),
  degree_count: z.number().int().nullable(),
});

export const listDegreeGroupsResultSchema = z.object({
  records: z.array(degreeGroupListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
});

export const degreeGroupIdResultSchema = z.object({
  degree_group_uuid: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Types derived from output schemas
// ---------------------------------------------------------------------------

export type DegreeGroupListItem = z.output<typeof degreeGroupListItemSchema>;
export type ListDegreeGroupsResult = z.output<typeof listDegreeGroupsResultSchema>;
export type DegreeGroupIdResult = z.output<typeof degreeGroupIdResultSchema>;
