import { z } from "zod";

export const listStoriesSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export const storyItemSchema = z.object({
  story_uuid: z.string().min(1),
  request_uuid: z.string().min(1),
  suggestion_uuid: z.string().nullable(),
  request_position_title: z.string().nullable(),
  staff_id: z.number().int().nullable(),
  staff_name: z.string().nullable(),
  number_of_employees: z.number().int().nullable(),
  story_status: z.number().int(),
  is_old: z.boolean().nullable(),
  story_time_spent: z.number().int().nullable(),
  story_created_at: z.string().nullable(),
  story_last_updated_at: z.string().nullable(),
});

export const listStoriesResultSchema = z.object({
  stories: z.array(storyItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
});

export const storyActionResponseSchema = z.object({
  operation: z.string().min(1),
  message: z.string().min(1),
});

// --- Mutation input schemas ---

export const createStorySchema = z.object({
  requestUuid: z.string().min(1, "Request UUID is required"),
  staffId: z.coerce.number().int().optional(),
  numberOfEmployees: z.coerce.number().int().optional(),
  storyStatus: z.coerce.number().int().optional().default(0),
  storyTimeSpent: z.coerce.number().int().optional(),
});

export const updateStorySchema = z.object({
  storyUuid: z.string().min(1, "Story UUID is required"),
  requestUuid: z.string().min(1).optional(),
  staffId: z.coerce.number().int().optional(),
  numberOfEmployees: z.coerce.number().int().optional(),
  storyStatus: z.coerce.number().int().optional(),
  storyTimeSpent: z.coerce.number().int().optional(),
  isOld: z.coerce.boolean().optional(),
});

export const deleteStorySchema = z.object({
  storyUuid: z.string().min(1, "Story UUID is required"),
});

export type ListStoriesInput = z.input<typeof listStoriesSchema>;
export type StoryItem = z.output<typeof storyItemSchema>;
export type ListStoriesResult = z.output<typeof listStoriesResultSchema>;
export type StoryActionResponse = z.output<typeof storyActionResponseSchema>;