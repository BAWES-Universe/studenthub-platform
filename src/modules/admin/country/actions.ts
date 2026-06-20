"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/modules/auth/session";
import {
  countryListItemSchema,
  listCountriesResultSchema,
  countryIdResultSchema,
} from "./schemas";
import type {
  CountryListItem,
  ListCountriesResult,
  CountryIdResult,
} from "./schemas";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function logOutputError(source: string, error: unknown): Promise<void> {
  console.error(`[modules/admin/country] ${source} output failed:`, error);
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const listCountriesSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  search: z.string().optional(),
});

const getCountrySchema = z.object({
  countryId: z.coerce.number().int().positive("Country ID is required"),
});

const createCountrySchema = z.object({
  country_name_en: z
    .string()
    .min(1, "English name is required")
    .max(100, "English name must be at most 100 characters"),
  country_name_ar: z
    .string()
    .max(100, "Arabic name must be at most 100 characters")
    .optional()
    .default(""),
  country_nationality_name_en: z
    .string()
    .min(1, "English nationality name is required")
    .max(100, "English nationality name must be at most 100 characters"),
  country_nationality_name_ar: z
    .string()
    .max(100, "Arabic nationality name must be at most 100 characters")
    .optional()
    .default(""),
  iso: z
    .string()
    .max(3, "ISO code must be at most 3 characters")
    .optional()
    .default(""),
  emoji: z
    .string()
    .max(255, "Emoji must be at most 255 characters")
    .optional()
    .default(""),
  country_code: z.coerce.number().int().optional(),
  currency_code: z
    .string()
    .max(3, "Currency code must be at most 3 characters")
    .optional()
    .default(""),
});

const updateCountrySchema = z.object({
  countryId: z.coerce.number().int().positive(),
  country_name_en: z
    .string()
    .min(1, "English name is required")
    .max(100)
    .optional(),
  country_name_ar: z
    .string()
    .max(100)
    .optional(),
  country_nationality_name_en: z
    .string()
    .min(1, "English nationality name is required")
    .max(100)
    .optional(),
  country_nationality_name_ar: z
    .string()
    .max(100)
    .optional(),
  iso: z.string().max(3).optional(),
  emoji: z.string().max(255).optional(),
  country_code: z.coerce.number().int().optional(),
  currency_code: z.string().max(3).optional(),
});

const deleteCountrySchema = z.object({
  countryId: z.coerce.number().int().positive(),
});

// ---------------------------------------------------------------------------
// listCountries
// ---------------------------------------------------------------------------

/**
 * List countries with pagination and optional search.
 */
export async function listCountries(
  params: FormData | z.input<typeof listCountriesSchema> = {},
): Promise<ListCountriesResult> {
  await requireCapability("admin.system");

  const raw =
    params instanceof FormData
      ? {
          page: params.get("page"),
          limit: params.get("limit"),
          search: params.get("search"),
        }
      : params;

  const parsed = listCountriesSchema.safeParse(raw);
  if (!parsed.success) {
    return { records: [], total: 0, page: 1, limit: 20, totalPages: 0 };
  }

  const { page, limit, search } = parsed.data;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (search) {
    where.OR = [
      { country_name_en: { contains: search } },
      { country_name_ar: { contains: search } },
      { country_nationality_name_en: { contains: search } },
      { country_nationality_name_ar: { contains: search } },
    ];
  }

  const [records, total] = await Promise.all([
    prisma.country.findMany({
      where: where as any,
      orderBy: { country_name_en: "asc" },
      skip,
      take: limit,
    }),
    prisma.country.count({ where: where as any }),
  ]);

  const result: ListCountriesResult = {
    records: records.map((r: any): CountryListItem => ({
      country_id: r.country_id,
      country_name_en: r.country_name_en,
      country_name_ar: r.country_name_ar ?? null,
      country_nationality_name_en: r.country_nationality_name_en,
      country_nationality_name_ar: r.country_nationality_name_ar ?? null,
      iso: r.iso ?? null,
      emoji: r.emoji ?? null,
      country_code: r.country_code ?? null,
      currency_code: r.currency_code ?? null,
      country_from_google_map: r.country_from_google_map ?? null,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };

  // Validate output shape
  const outputParsed = listCountriesResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("listCountries", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// getCountry
// ---------------------------------------------------------------------------

/**
 * Get a single country by ID.
 * Returns null if not found.
 */
export async function getCountry(
  countryId: number,
): Promise<CountryListItem | null> {
  await requireCapability("admin.system");

  const parsed = getCountrySchema.safeParse({ countryId });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid country ID");
  }

  const record = await prisma.country.findFirst({
    where: { country_id: parsed.data.countryId },
  });

  if (!record) return null;

  const raw = record as any;
  const result: CountryListItem = {
    country_id: raw.country_id,
    country_name_en: raw.country_name_en,
    country_name_ar: raw.country_name_ar ?? null,
    country_nationality_name_en: raw.country_nationality_name_en,
    country_nationality_name_ar: raw.country_nationality_name_ar ?? null,
    iso: raw.iso ?? null,
    emoji: raw.emoji ?? null,
    country_code: raw.country_code ?? null,
    currency_code: raw.currency_code ?? null,
    country_from_google_map: raw.country_from_google_map ?? null,
  };

  // Validate output shape
  const outputParsed = countryListItemSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("getCountry", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// createCountry
// ---------------------------------------------------------------------------

/**
 * Create a new country record.
 */
export async function createCountry(
  data: z.input<typeof createCountrySchema>,
): Promise<CountryIdResult> {
  await requireCapability("admin.system");

  const parsed = createCountrySchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid country data");
  }

  const {
    country_name_en,
    country_name_ar,
    country_nationality_name_en,
    country_nationality_name_ar,
    iso,
    emoji,
    country_code,
    currency_code,
  } = parsed.data;

  const record = await prisma.country.create({
    data: {
      country_name_en,
      country_name_ar: country_name_ar || null,
      country_nationality_name_en,
      country_nationality_name_ar: country_nationality_name_ar || null,
      iso: iso || null,
      emoji: emoji || null,
      country_code: country_code ?? null,
      currency_code: currency_code || null,
    } as any,
  });

  revalidatePath("/admin/country");
  const result: CountryIdResult = { country_id: record.country_id };

  const outputParsed = countryIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("createCountry", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// updateCountry
// ---------------------------------------------------------------------------

/**
 * Update an existing country record.
 * Throws an error if the record does not exist.
 */
export async function updateCountry(
  data: z.input<typeof updateCountrySchema>,
): Promise<CountryIdResult> {
  await requireCapability("admin.system");

  const parsed = updateCountrySchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid country data");
  }

  const {
    countryId,
    country_name_en,
    country_name_ar,
    country_nationality_name_en,
    country_nationality_name_ar,
    iso,
    emoji,
    country_code,
    currency_code,
  } = parsed.data;

  // Verify the record exists
  const existing = await prisma.country.findFirst({
    where: { country_id: countryId },
  });
  if (!existing) {
    throw new Error(`Country record not found: ${countryId}`);
  }

  const updateData: Record<string, unknown> = {};
  if (country_name_en !== undefined) updateData.country_name_en = country_name_en;
  if (country_name_ar !== undefined) updateData.country_name_ar = country_name_ar || null;
  if (country_nationality_name_en !== undefined) updateData.country_nationality_name_en = country_nationality_name_en;
  if (country_nationality_name_ar !== undefined) updateData.country_nationality_name_ar = country_nationality_name_ar || null;
  if (iso !== undefined) updateData.iso = iso || null;
  if (emoji !== undefined) updateData.emoji = emoji || null;
  if (country_code !== undefined) updateData.country_code = country_code ?? null;
  if (currency_code !== undefined) updateData.currency_code = currency_code || null;

  await prisma.country.update({
    where: { country_id: countryId },
    data: updateData as any,
  });

  revalidatePath("/admin/country");
  const result: CountryIdResult = { country_id: countryId };

  const outputParsed = countryIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("updateCountry", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// deleteCountry
// ---------------------------------------------------------------------------

/**
 * Delete a country record.
 * Throws an error if the record does not exist.
 */
export async function deleteCountry(
  countryId: number,
): Promise<CountryIdResult> {
  await requireCapability("admin.system");

  const parsed = deleteCountrySchema.safeParse({ countryId });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid country ID");
  }

  // Verify the record exists
  const existing = await prisma.country.findFirst({
    where: { country_id: parsed.data.countryId },
  });
  if (!existing) {
    throw new Error(`Country record not found: ${parsed.data.countryId}`);
  }

  await prisma.country.delete({
    where: { country_id: parsed.data.countryId },
  });

  revalidatePath("/admin/country");
  const result: CountryIdResult = { country_id: parsed.data.countryId };

  const outputParsed = countryIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("deleteCountry", outputParsed.error.issues);
  }

  return result;
}
