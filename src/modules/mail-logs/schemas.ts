import { z } from "zod";

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

export const mailLogListItemSchema = z.object({
  mail_uuid: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  subject: z.string().nullable(),
  app: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export type MailLogListItem = z.output<typeof mailLogListItemSchema>;

export const listMailLogsResultSchema = z.object({
  records: z.array(mailLogListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().min(1).max(100),
  totalPages: z.number().int().nonnegative(),
});

export type ListMailLogsResult = z.output<typeof listMailLogsResultSchema>;

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const listMailLogsSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().max(255).optional(),
});

export const getMailLogSchema = z.object({
  mailUuid: z.string().min(1, "Mail UUID is required"),
});
