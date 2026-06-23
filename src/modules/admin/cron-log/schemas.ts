import { z } from "zod";

// ---------------------------------------------------------------------------
// Input validation schemas
// ---------------------------------------------------------------------------

export const listCronLogsSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const getCronLogSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Output validation schemas
// ---------------------------------------------------------------------------

export const cronLogItemSchema = z.object({
  id: z.number().int(),
  task: z.string(),
  last_ran_at: z.date().nullable(),
  last_output: z.string().nullable(),
});

export type CronLogItem = z.infer<typeof cronLogItemSchema>;

export const listCronLogsResultSchema = z.object({
  records: z.array(cronLogItemSchema),
  total: z.number().int().nonnegative(),
});

export type ListCronLogsResult = z.infer<typeof listCronLogsResultSchema>;

export const cronLogDetailSchema = cronLogItemSchema.extend({});

export type CronLogDetail = z.infer<typeof cronLogDetailSchema>;

export const getCronLogResultSchema = cronLogDetailSchema;

export type GetCronLogResult = z.infer<typeof getCronLogResultSchema>;
