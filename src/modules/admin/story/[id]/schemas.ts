import { z } from "zod";

/**
 * Input schema for getStory.
 */
export const getStorySchema = z.object({
  storyUuid: z.string().min(1, "Story UUID is required"),
});

/**
 * Schema for a single story item in detail response.
 */
export const storyDetailItemSchema = z.object({
  story_uuid: z.string().min(1),
  request_uuid: z.string().min(1),
  suggestion_uuid: z.string().nullable(),
  staff_id: z.number().int().nullable(),
  number_of_employees: z.number().int().nullable(),
  story_status: z.number().int(),
  is_old: z.boolean().nullable(),
  story_time_spent: z.number().int().nullable(),
  story_created_at: z.date().nullable(),
  story_last_updated_at: z.date().nullable(),
});

/**
 * Output schema for getStory.
 */
export const getStoryResultSchema = z.object({
  story: storyDetailItemSchema.nullable(),
});

export type StoryDetailItem = z.output<typeof storyDetailItemSchema>;
export type GetStoryResult = z.output<typeof getStoryResultSchema>;
export type GetStoryInput = z.input<typeof getStorySchema>;