"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/modules/auth/session";
import {
  cronLogItemSchema,
  listCronLogsResultSchema,
  listCronLogsSchema,
  getCronLogSchema,
} from "./schemas";
import type { CronLogItem, ListCronLogsResult } from "./schemas";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function logOutputError(source: string, error: unknown): void {
  console.error(`[modules/admin/cron-log] ${source} output failed:`, error);
}

// ---------------------------------------------------------------------------
// listCronLogs
// ---------------------------------------------------------------------------

export async function listCronLogs(options?: {
  page?: number;
  limit?: number;
}): Promise<ListCronLogsResult> {
  await requireCapability("admin.read");

  const { page, limit } = listCronLogsSchema.parse(options ?? {});
  const skip = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    prisma.cron_log.findMany({
      skip,
      take: limit,
      orderBy: { id: "desc" },
    }),
    prisma.cron_log.count(),
  ]);

  const records: CronLogItem[] = rows.map((row) => ({
    id: row.id,
    task: row.task,
    last_ran_at: row.last_ran_at,
    last_output: row.last_output,
  }));

  const parsed = listCronLogsResultSchema.safeParse({ records, total });
  if (!parsed.success) {
    logOutputError("listCronLogs", parsed.error);
    return { records: [], total: 0 };
  }

  return parsed.data;
}

// ---------------------------------------------------------------------------
// getCronLog
// ---------------------------------------------------------------------------

export async function getCronLog(id: number): Promise<CronLogItem | null> {
  await requireCapability("admin.read");

  const { id: parsedId } = getCronLogSchema.parse({ id });

  const row = await prisma.cron_log.findUnique({
    where: { id: parsedId },
  });

  if (!row) return null;

  const record: CronLogItem = {
    id: row.id,
    task: row.task,
    last_ran_at: row.last_ran_at,
    last_output: row.last_output,
  };

  const parsed = cronLogItemSchema.safeParse(record);
  if (!parsed.success) {
    logOutputError("getCronLog", parsed.error);
    return null;
  }

  return parsed.data;
}
