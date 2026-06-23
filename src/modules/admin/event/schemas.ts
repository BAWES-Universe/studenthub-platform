import { z } from "zod";

// ---------------------------------------------------------------------------
// Schemas for src/modules/admin/event actions
// ---------------------------------------------------------------------------

export const listEventsSchema = z.object({
  requestUuid: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const getEventSchema = z.object({
  id: z.string().min(1, "Invalid event ID"),
});

export type ListEventsParams = z.input<typeof listEventsSchema>;
export type GetEventParams = z.input<typeof getEventSchema>;

// ---------------------------------------------------------------------------
// Output validation schemas
// ---------------------------------------------------------------------------

export const eventItemSchema = z.object({
  activity_uuid: z.string(),
  request_uuid: z.string(),
  activity_detail: z.string(),
  staff_name: z.string().nullable(),
  activity_created_datetime: z.date().nullable(),
  activity_updated_datetime: z.date().nullable(),
});

export const listEventsResultSchema = z.object({
  events: z.array(eventItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Types derived from output schemas
// ---------------------------------------------------------------------------

export type EventItem = z.output<typeof eventItemSchema>;
export type ListEventsResult = z.output<typeof listEventsResultSchema>;
