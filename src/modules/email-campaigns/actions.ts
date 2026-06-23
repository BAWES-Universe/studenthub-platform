"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/modules/auth/session";
import {
  listEmailCampaignsSchema,
  getEmailCampaignSchema,
  listEmailCampaignsResultSchema,
  emailCampaignListItemSchema,
  type EmailCampaignListItem,
  type ListEmailCampaignsResult,
} from "./schemas";

// ---------------------------------------------------------------------------
// listEmailCampaigns
// ---------------------------------------------------------------------------

/**
 * List email campaigns with pagination and optional search on subject.
 * Mirrors the legacy Yii2 Admin EmailCampaignController::actionList().
 */
export async function listEmailCampaigns(
  params: FormData | z.input<typeof listEmailCampaignsSchema> = {},
): Promise<ListEmailCampaignsResult> {
  await requireCapability("admin.system");

  const raw =
    params instanceof FormData
      ? {
          page: params.get("page"),
          limit: params.get("limit"),
          search: params.get("search"),
        }
      : params;

  const parsed = listEmailCampaignsSchema.safeParse(raw);
  if (!parsed.success) {
    return { records: [], total: 0, page: 1, limit: 20, totalPages: 0 };
  }

  const { page, limit, search } = parsed.data;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};

  if (search && search.trim()) {
    where.OR = [
      { subject: { contains: search, mode: "insensitive" } },
    ];
  }

  const [records, total] = await Promise.all([
    prisma.email_campaign.findMany({
      where: where as any,
      orderBy: { created_at: "desc" },
      skip,
      take: limit,
    }),
    prisma.email_campaign.count({ where: where as any }),
  ]);

  const result: ListEmailCampaignsResult = {
    records: records.map((r): EmailCampaignListItem => ({
      campaign_uuid: r.campaign_uuid,
      subject: r.subject ?? null,
      message: r.message ?? null,
      progress: r.progress ?? null,
      trigger_date_time: r.trigger_date_time?.toISOString() ?? null,
      last_trigger_date_time: r.last_trigger_date_time?.toISOString() ?? null,
      is_recurring: r.is_recurring ?? null,
      trigger_period: r.trigger_period ?? null,
      target: r.target ?? null,
      status: r.status ?? null,
      created_at: r.created_at?.toISOString() ?? null,
      updated_at: r.updated_at?.toISOString() ?? null,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };

  const outputParsed = listEmailCampaignsResultSchema.safeParse(result);
  if (!outputParsed.success) {
    console.error(
      "[modules/email-campaigns] listEmailCampaigns output validation failed:",
      outputParsed.error.issues,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// getEmailCampaign
// ---------------------------------------------------------------------------

/**
 * Get a single email campaign by UUID.
 * Mirrors the legacy Yii2 Admin EmailCampaignController::actionView().
 * Returns null if not found.
 */
export async function getEmailCampaign(
  campaignUuid: string,
): Promise<EmailCampaignListItem | null> {
  await requireCapability("admin.system");

  const parsed = getEmailCampaignSchema.safeParse({ campaignUuid });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid campaign UUID");
  }

  const record = await prisma.email_campaign.findFirst({
    where: { campaign_uuid: parsed.data.campaignUuid },
  });

  if (!record) return null;

  const result: EmailCampaignListItem = {
    campaign_uuid: record.campaign_uuid,
    subject: record.subject ?? null,
    message: record.message ?? null,
    progress: record.progress ?? null,
    trigger_date_time: record.trigger_date_time?.toISOString() ?? null,
    last_trigger_date_time: record.last_trigger_date_time?.toISOString() ?? null,
    is_recurring: record.is_recurring ?? null,
    trigger_period: record.trigger_period ?? null,
    target: record.target ?? null,
    status: record.status ?? null,
    created_at: record.created_at?.toISOString() ?? null,
    updated_at: record.updated_at?.toISOString() ?? null,
  };

  const outputParsed = emailCampaignListItemSchema.safeParse(result);
  if (!outputParsed.success) {
    console.error(
      "[modules/email-campaigns] getEmailCampaign output validation failed:",
      outputParsed.error.issues,
    );
  }

  return result;
}
