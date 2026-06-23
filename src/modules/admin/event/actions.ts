"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/modules/auth/session";
import {
  listEventsSchema,
  getEventSchema,
  eventItemSchema,
  listEventsResultSchema,
} from "./schemas";
import type {
  ListEventsParams,
  GetEventParams,
  EventItem,
  ListEventsResult,
} from "./schemas";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function logOutputError(source: string, error: unknown): Promise<void> {
  console.error(`[modules/admin/event] ${source} output failed:`, error);
}

// ---------------------------------------------------------------------------
// listEvents
// ---------------------------------------------------------------------------

/**
 * List request activity events with pagination and optional filters.
 */
export async function listEvents(
  params: ListEventsParams = {},
): Promise<ListEventsResult> {
  await requireCapability("request.read.any");

  const parsed = listEventsSchema.safeParse(params);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid list parameters");
  }

  const { requestUuid, dateFrom, dateTo, page = 1, limit = 20 } = parsed.data;

  const where: Record<string, unknown> = {};

  if (requestUuid) {
    where.request_uuid = requestUuid;
  }
  if (dateFrom || dateTo) {
    const createdAt: Record<string, unknown> = {};
    if (dateFrom) createdAt.gte = new Date(dateFrom);
    if (dateTo) createdAt.lte = new Date(dateTo);
    where.activity_created_datetime = createdAt;
  }

  const [activities, total] = await Promise.all([
    prisma.request_activity.findMany({
      where: where as any,
      orderBy: { activity_created_datetime: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        activity_uuid: true,
        request_uuid: true,
        activity_detail: true,
        activity_created_datetime: true,
        activity_updated_datetime: true,
        staff: {
          select: { staff_name: true },
        },
      },
    }),
    prisma.request_activity.count({ where: where as any }),
  ]);

  const result: ListEventsResult = {
    events: activities.map((a) => ({
      activity_uuid: a.activity_uuid,
      request_uuid: a.request_uuid,
      activity_detail: a.activity_detail,
      staff_name: a.staff?.staff_name ?? null,
      activity_created_datetime: a.activity_created_datetime,
      activity_updated_datetime: a.activity_updated_datetime,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };

  // Validate output shape
  const outputParsed = listEventsResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("listEvents", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// getEvent
// ---------------------------------------------------------------------------

/**
 * Get a single activity event by UUID.
 */
export async function getEvent(
  params: GetEventParams,
): Promise<EventItem | null> {
  await requireCapability("request.read.any");

  const parsed = getEventSchema.safeParse(params);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid event ID");
  }

  const { id } = parsed.data;

  const activity = await prisma.request_activity.findFirst({
    where: { activity_uuid: id },
    select: {
      activity_uuid: true,
      request_uuid: true,
      activity_detail: true,
      activity_created_datetime: true,
      activity_updated_datetime: true,
      staff: {
        select: { staff_name: true },
      },
    },
  });

  if (!activity) return null;

  const result: EventItem = {
    activity_uuid: activity.activity_uuid,
    request_uuid: activity.request_uuid,
    activity_detail: activity.activity_detail,
    staff_name: activity.staff?.staff_name ?? null,
    activity_created_datetime: activity.activity_created_datetime,
    activity_updated_datetime: activity.activity_updated_datetime,
  };

  // Validate output shape
  const outputParsed = eventItemSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("getEvent", outputParsed.error.issues);
  }

  return result;
}
