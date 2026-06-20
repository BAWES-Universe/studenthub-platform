import { z } from "zod";

// ---------------------------------------------------------------------------
// Output validation schemas
// ---------------------------------------------------------------------------

export const countryListItemSchema = z.object({
  country_id: z.number().int(),
  country_name_en: z.string(),
  country_name_ar: z.string().nullable(),
  country_nationality_name_en: z.string(),
  country_nationality_name_ar: z.string().nullable(),
  iso: z.string().nullable(),
  emoji: z.string().nullable(),
  country_code: z.number().int().nullable(),
  currency_code: z.string().nullable(),
  country_from_google_map: z.boolean().nullable(),
});

export const listCountriesResultSchema = z.object({
  records: z.array(countryListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
});

export const countryIdResultSchema = z.object({
  country_id: z.number().int(),
});

// ---------------------------------------------------------------------------
// Types derived from output schemas
// ---------------------------------------------------------------------------

export type CountryListItem = z.output<typeof countryListItemSchema>;
export type ListCountriesResult = z.output<typeof listCountriesResultSchema>;
export type CountryIdResult = z.output<typeof countryIdResultSchema>;
