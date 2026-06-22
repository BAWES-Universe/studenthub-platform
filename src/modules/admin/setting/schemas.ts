import { z } from "zod";

// ---------------------------------------------------------------------------
// Output validation schemas for admin/setting
// ---------------------------------------------------------------------------

export const settingListItemSchema = z.object({
  id: z.string(),
  code: z.string(),
  key: z.string(),
  value: z.string(),
  serialized: z.string(),
  updated: z.string(),
});

export const listSettingsResultSchema = z.array(settingListItemSchema);

export const settingDetailSchema = z.object({
  setting_uuid: z.string(),
  code: z.string(),
  key: z.string(),
  value: z.string().nullable(),
  serialized: z.boolean().nullable(),
  created_at: z.date().nullable(),
  updated_at: z.date().nullable(),
});

export const settingCreateResultSchema = z.object({
  uuid: z.string(),
});

// ---------------------------------------------------------------------------
// Types derived from output schemas
// ---------------------------------------------------------------------------

export type SettingListItem = z.output<typeof settingListItemSchema>;
export type SettingDetail = z.output<typeof settingDetailSchema>;
export type SettingCreateResult = z.output<typeof settingCreateResultSchema>;
