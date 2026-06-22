import { z } from "zod";

// ---------------------------------------------------------------------------
// Output validation schemas
// ---------------------------------------------------------------------------

export const universityListItemSchema = z.object({
  university_id: z.number().int().positive(),
  university_name_en: z.string().nullable(),
  university_name_ar: z.string().nullable(),
  university_data_source: z.number().int().nullable(),
  candidate_count: z.number().int().nullable(),
});

export const listUniversitiesResultSchema = z.object({
  records: z.array(universityListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
});

export const universityIdResultSchema = z.object({
  university_id: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Types derived from output schemas
// ---------------------------------------------------------------------------

export type UniversityListItem = z.output<typeof universityListItemSchema>;
export type ListUniversitiesResult = z.output<typeof listUniversitiesResultSchema>;
export type UniversityIdResult = z.output<typeof universityIdResultSchema>;
