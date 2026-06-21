"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/modules/auth/session";
import {
  dailyStandupAnswerItemSchema,
  listDailyStandupsResultSchema,
} from "./schemas";
import type {
  DailyStandupAnswerItem,
  ListDailyStandupsResult,
} from "./schemas";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function logOutputError(source: string, error: unknown): Promise<void> {
  console.error(`[modules/admin/daily-standup] ${source} output failed:`, error);
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const listDailyStandupsSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

const getDailyStandupAnswerSchema = z.object({
  answerUuid: z.string().min(1, "Answer UUID is required"),
});

// ---------------------------------------------------------------------------
// listDailyStandups
// ---------------------------------------------------------------------------

/**
 * List daily standup answers with pagination.
 */
export async function listDailyStandups(
  input?: z.input<typeof listDailyStandupsSchema>,
): Promise<ListDailyStandupsResult> {
  await requireCapability("admin.read");

  const parsed = listDailyStandupsSchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues[0]?.message ?? "Invalid pagination parameters",
    );
  }

  const { page, limit } = parsed.data;
  const skip = (page - 1) * limit;

  const [records, total] = await Promise.all([
    prisma.daily_standup_answer.findMany({
      skip,
      take: limit,
      orderBy: { updated_at: "desc" },
    }),
    prisma.daily_standup_answer.count(),
  ]);

  const result: ListDailyStandupsResult = {
    records: records.map((r): DailyStandupAnswerItem => ({
      answer_uuid: r.answer_uuid,
      staff_id: r.staff_id ?? null,
      question_uuid: r.question_uuid ?? null,
      question: r.question ?? null,
      answer: r.answer ?? null,
      created_at: r.created_at ?? null,
      updated_at: r.updated_at ?? null,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };

  // Validate output shape
  const outputParsed = listDailyStandupsResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("listDailyStandups", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// getDailyStandupAnswer
// ---------------------------------------------------------------------------

/**
 * Get a single daily standup answer by UUID.
 * Returns null if not found.
 */
export async function getDailyStandupAnswer(
  answerUuid: string,
): Promise<DailyStandupAnswerItem | null> {
  await requireCapability("admin.read");

  const parsed = getDailyStandupAnswerSchema.safeParse({ answerUuid });
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues[0]?.message ?? "Invalid answer UUID",
    );
  }

  const record = await prisma.daily_standup_answer.findFirst({
    where: { answer_uuid: parsed.data.answerUuid },
  });

  if (!record) return null;

  const result: DailyStandupAnswerItem = {
    answer_uuid: record.answer_uuid,
    staff_id: record.staff_id ?? null,
    question_uuid: record.question_uuid ?? null,
    question: record.question ?? null,
    answer: record.answer ?? null,
    created_at: record.created_at ?? null,
    updated_at: record.updated_at ?? null,
  };

  // Validate output shape
  const outputParsed = dailyStandupAnswerItemSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("getDailyStandupAnswer", outputParsed.error.issues);
  }

  return result;
}
