import { z } from "zod";

export const webhookListItemSchema = z.object({
  id: z.number(),
  event: z.string(),
  endpoint: z.string(),
  method: z.string(),
  created: z.string(),
  updated: z.string(),
});

export const listWebhooksResultSchema = z.array(webhookListItemSchema);

export const webhookDetailSchema = z.object({
  webhook_id: z.number(),
  event: z.string(),
  endpoint: z.string(),
  method: z.string().nullable(),
  created_at: z.date().nullable(),
  updated_at: z.date().nullable(),
});

export const webhookCreateInputSchema = z.object({
  event: z.string().min(1).max(50),
  endpoint: z.string().min(1).max(255),
  method: z.string().optional(),
});

export const webhookCreateResultSchema = z.object({
  webhook_id: z.number(),
});
