import { z } from "zod";

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

export const emailCampaignListItemSchema = z.object({
  campaign_uuid: z.string(),
  subject: z.string().nullable(),
  message: z.string().nullable(),
  progress: z.number().int().nullable(),
  trigger_date_time: z.string().nullable(),
  last_trigger_date_time: z.string().nullable(),
  is_recurring: z.boolean().nullable(),
  trigger_period: z.number().int().nullable(),
  target: z.string().nullable(),
  status: z.boolean().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export type EmailCampaignListItem = z.output<typeof emailCampaignListItemSchema>;

export const listEmailCampaignsResultSchema = z.object({
  records: z.array(emailCampaignListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().min(1).max(100),
  totalPages: z.number().int().nonnegative(),
});

export type ListEmailCampaignsResult = z.output<typeof listEmailCampaignsResultSchema>;

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const listEmailCampaignsSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().max(255).optional(),
});

export const getEmailCampaignSchema = z.object({
  campaignUuid: z.string().min(1, "Campaign UUID is required"),
});
