import { z } from "zod";

// ---------------------------------------------------------------------------
// Output validation schemas
// ---------------------------------------------------------------------------

export const fulltimerListItemSchema = z.object({
  fulltimer_uuid: z.string(),
  fulltimer_name: z.string(),
  fulltimer_email: z.string(),
  fulltimer_phone: z.string().nullable(),
  country_name: z.string().nullable(),
  nationality_name: z.string().nullable(),
  fulltimer_employed: z.boolean().nullable(),
  fulltimer_created_datetime: z.date(),
  fulltimer_updated_datetime: z.date(),
});

export const listFulltimersResultSchema = z.object({
  records: z.array(fulltimerListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
});

export const fulltimerDetailSchema = z.object({
  fulltimer_uuid: z.string(),
  fulltimer_name: z.string(),
  fulltimer_email: z.string(),
  fulltimer_phone: z.string().nullable(),
  fulltimer_employed: z.boolean().nullable(),
  fulltimer_gender: z.boolean().nullable(),
  fulltimer_birth_date: z.date().nullable(),
  fulltimer_driving_license: z.boolean().nullable(),
  fulltimer_current_salary: z.string().nullable(),
  fulltimer_expected_salary: z.string().nullable(),
  currency_code: z.string().nullable(),
  country_name: z.string().nullable(),
  nationality_name: z.string().nullable(),
  university_name: z.string().nullable(),
  area_name: z.string().nullable(),
  fulltimer_created_datetime: z.date(),
  fulltimer_updated_datetime: z.date(),
});

export const fulltimerIdResultSchema = z.object({
  fulltimer_uuid: z.string(),
});

// ---------------------------------------------------------------------------
// Types derived from output schemas
// ---------------------------------------------------------------------------

export type FulltimerListItem = z.output<typeof fulltimerListItemSchema>;
export type ListFulltimersResult = z.output<typeof listFulltimersResultSchema>;
export type FulltimerDetail = z.output<typeof fulltimerDetailSchema>;
export type FulltimerIdResult = z.output<typeof fulltimerIdResultSchema>;
