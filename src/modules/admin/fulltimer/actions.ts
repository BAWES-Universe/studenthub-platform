"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/modules/auth/session";
import {
  fulltimerListItemSchema,
  listFulltimersResultSchema,
  fulltimerDetailSchema,
  fulltimerIdResultSchema,
} from "./schemas";
import type {
  FulltimerListItem,
  ListFulltimersResult,
  FulltimerDetail,
  FulltimerIdResult,
} from "./schemas";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function logOutputError(source: string, error: unknown): Promise<void> {
  console.error(`[modules/admin/fulltimer] ${source} output failed:`, error);
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const listFulltimersSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  search: z.string().optional(),
});

const getFulltimerSchema = z.object({
  fulltimerUuid: z.string().min(1, "Fulltimer UUID is required"),
});

const deleteFulltimerSchema = z.object({
  fulltimer_uuid: z.string().min(1),
});

// ---------------------------------------------------------------------------
// listFulltimers
// ---------------------------------------------------------------------------

/**
 * List fulltimers with pagination and optional search.
 */
export async function listFulltimers(
  params: FormData | z.input<typeof listFulltimersSchema> = {},
): Promise<ListFulltimersResult> {
  await requireCapability("admin.system");

  const raw =
    params instanceof FormData
      ? {
          page: params.get("page"),
          limit: params.get("limit"),
          search: params.get("search"),
        }
      : params;

  const parsed = listFulltimersSchema.safeParse(raw);
  if (!parsed.success) {
    return { records: [], total: 0, page: 1, limit: 20, totalPages: 0 };
  }

  const { page, limit, search } = parsed.data;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (search) {
    where.OR = [
      { fulltimer_name: { contains: search } },
      { fulltimer_email: { contains: search } },
      { fulltimer_phone: { contains: search } },
    ];
  }

  const [records, total] = await Promise.all([
    prisma.fulltimer.findMany({
      where: where as any,
      orderBy: { fulltimer_created_datetime: "desc" },
      skip,
      take: limit,
      include: {
        country_fulltimer_country_idTocountry: { select: { country_name_en: true } },
        country_fulltimer_nationality_idTocountry: { select: { country_name_en: true } },
      },
    }),
    prisma.fulltimer.count({ where: where as any }),
  ]);

  const result: ListFulltimersResult = {
    records: records.map((r: any): FulltimerListItem => ({
      fulltimer_uuid: r.fulltimer_uuid,
      fulltimer_name: r.fulltimer_name,
      fulltimer_email: r.fulltimer_email,
      fulltimer_phone: r.fulltimer_phone ?? null,
      country_name: r.country_fulltimer_country_idTocountry?.country_name_en ?? null,
      nationality_name: r.country_fulltimer_nationality_idTocountry?.country_name_en ?? null,
      fulltimer_employed: r.fulltimer_employed ?? null,
      fulltimer_created_datetime: r.fulltimer_created_datetime,
      fulltimer_updated_datetime: r.fulltimer_updated_datetime,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };

  const outputParsed = listFulltimersResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("listFulltimers", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// getFulltimer
// ---------------------------------------------------------------------------

/**
 * Get a single fulltimer by UUID.
 * Returns null if not found.
 */
export async function getFulltimer(
  fulltimerUuid: string,
): Promise<FulltimerDetail | null> {
  await requireCapability("admin.system");

  const parsed = getFulltimerSchema.safeParse({ fulltimerUuid });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid fulltimer UUID");
  }

  const record = await prisma.fulltimer.findFirst({
    where: { fulltimer_uuid: parsed.data.fulltimerUuid },
    include: {
      country_fulltimer_country_idTocountry: { select: { country_name_en: true } },
      country_fulltimer_nationality_idTocountry: { select: { country_name_en: true } },
      university: { select: { university_name_en: true } },
      area: { select: { area_name_en: true } },
    },
  });

  if (!record) return null;

  const raw = record as any;
  const result: FulltimerDetail = {
    fulltimer_uuid: raw.fulltimer_uuid,
    fulltimer_name: raw.fulltimer_name,
    fulltimer_email: raw.fulltimer_email,
    fulltimer_phone: raw.fulltimer_phone ?? null,
    fulltimer_employed: raw.fulltimer_employed ?? null,
    fulltimer_gender: raw.fulltimer_gender ?? null,
    fulltimer_birth_date: raw.fulltimer_birth_date ?? null,
    fulltimer_driving_license: raw.fulltimer_driving_license ?? null,
    fulltimer_current_salary: raw.fulltimer_current_salary ?? null,
    fulltimer_expected_salary: raw.fulltimer_expected_salary ?? null,
    currency_code: raw.currency_code ?? null,
    country_name: raw.country_fulltimer_country_idTocountry?.country_name_en ?? null,
    nationality_name: raw.country_fulltimer_nationality_idTocountry?.country_name_en ?? null,
    university_name: raw.university?.university_name_en ?? null,
    area_name: raw.area?.area_name_en ?? null,
    fulltimer_created_datetime: raw.fulltimer_created_datetime,
    fulltimer_updated_datetime: raw.fulltimer_updated_datetime,
  };

  const outputParsed = fulltimerDetailSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("getFulltimer", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// deleteFulltimer
// ---------------------------------------------------------------------------

/**
 * Delete a fulltimer record.
 * Throws an error if the record does not exist.
 */
export async function deleteFulltimer(
  fulltimer_uuid: string,
): Promise<FulltimerIdResult> {
  await requireCapability("admin.system");

  const parsed = deleteFulltimerSchema.safeParse({ fulltimer_uuid });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid fulltimer UUID");
  }

  const existing = await prisma.fulltimer.findFirst({
    where: { fulltimer_uuid: parsed.data.fulltimer_uuid },
  });
  if (!existing) {
    throw new Error(`Fulltimer not found: ${parsed.data.fulltimer_uuid}`);
  }

  await prisma.fulltimer.delete({
    where: { fulltimer_uuid: parsed.data.fulltimer_uuid },
  });

  revalidatePath("/admin/fulltimer");
  const result: FulltimerIdResult = { fulltimer_uuid: parsed.data.fulltimer_uuid };

  const outputParsed = fulltimerIdResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("deleteFulltimer", outputParsed.error.issues);
  }

  return result;
}
