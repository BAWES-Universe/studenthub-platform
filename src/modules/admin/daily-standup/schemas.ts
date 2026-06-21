import { z } from "zod";

// ---------------------------------------------------------------------------
// Input validation schemas
// ---------------------------------------------------------------------------

export const listDailyStandupsSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export const getDailyStandupAnswerSchema = z.object({
  answerUuid: z.string().min(1, "Answer UUID is required"),
});

// ---------------------------------------------------------------------------
// Output validation schemas
// ---------------------------------------------------------------------------

export const dailyStandupAnswerItemSchema = z.object({
  answer_uuid: z.string().min(1),
  staff_id: z.number().int().nullable(),
  question_uuid: z.string().nullable(),
  question: z.string().nullable(),
  answer: z.string().nullable(),
  created_at: z.date().nullable(),
  updated_at: z.date().nullable(),
});

export const listDailyStandupsResultSchema = z.object({
  records: z.array(dailyStandupAnswerItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
});

export const dailyStandupDetailSchema = dailyStandupAnswerItemSchema;

// ---------------------------------------------------------------------------
// Types derived from output schemas
// ---------------------------------------------------------------------------

export type DailyStandupAnswerItem = z.output<typeof dailyStandupAnswerItemSchema>;
export type ListDailyStandupsResult = z.output<typeof listDailyStandupsResultSchema>;
export type DailyStandupDetail = z.output<typeof dailyStandupDetailSchema>;
