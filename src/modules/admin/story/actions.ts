"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/modules/auth/session";
import {
  listStoriesSchema,
  createStorySchema,
  updateStorySchema,
  deleteStorySchema,
  listStoriesResultSchema,
} from "./schemas";
import type { ListStoriesInput, ListStoriesResult, StoryActionResponse } from "./schemas";

export async function listStories(
  input: ListStoriesInput = {},
): Promise<ListStoriesResult> {
  await requireCapability("admin.read");
  const parsed = listStoriesSchema.safeParse(input);
  if (!parsed.success)
    return { stories: [], total: 0, page: 1, limit: 50, totalPages: 0 };

  const { page, limit } = parsed.data;
  const skip = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    prisma.story.findMany({
      orderBy: { story_last_updated_at: "desc" },
      skip,
      take: limit,
    }),
    prisma.story.count(),
  ]);

  const stories = rows.map((row: Record<string, unknown>) => ({
    story_uuid: row.story_uuid as string,
    request_uuid: row.request_uuid as string,
    suggestion_uuid: (row.suggestion_uuid as string) ?? null,
    request_position_title: (row.request_position_title as string) ?? null,
    staff_id: (row.staff_id as number) ?? null,
    staff_name: (row.staff_name as string) ?? null,
    number_of_employees: (row.number_of_employees as number) ?? null,
    story_status: row.story_status as number,
    is_old: (row.is_old as boolean) ?? null,
    story_time_spent: (row.story_time_spent as number) ?? null,
    story_created_at: (row.story_created_at as Date)?.toISOString() ?? null,
    story_last_updated_at: (row.story_last_updated_at as Date)?.toISOString() ?? null,
  }));

  const result = {
    stories,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };

  const outputParsed = listStoriesResultSchema.safeParse(result);
  if (!outputParsed.success) {
    console.error(
      "[admin/story] listStories output failed:",
      outputParsed.error.issues,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// createStory
// ---------------------------------------------------------------------------

export async function createStory(
  _prev: unknown,
  formData: FormData,
): Promise<StoryActionResponse> {
  await requireCapability("admin.system");

  const raw = {
    requestUuid: formData.get("requestUuid") as string,
    staffId: formData.get("staffId") as string | null,
    numberOfEmployees: formData.get("numberOfEmployees") as string | null,
    storyStatus: formData.get("storyStatus") as string | null,
    storyTimeSpent: formData.get("storyTimeSpent") as string | null,
  };

  const parsed = createStorySchema.safeParse(raw);
  if (!parsed.success) {
    return { operation: "error", message: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { requestUuid, staffId, numberOfEmployees, storyStatus, storyTimeSpent } = parsed.data;

  await prisma.story.create({
    data: {
      request_uuid: requestUuid,
      staff_id: staffId ?? null,
      number_of_employees: numberOfEmployees ?? null,
      story_status: storyStatus,
      story_time_spent: storyTimeSpent ?? null,
      story_created_at: new Date(),
      story_last_updated_at: new Date(),
    } as any,
  });

  revalidatePath("/admin/story");
  return { operation: "success", message: "Story created" };
}

// ---------------------------------------------------------------------------
// updateStory
// ---------------------------------------------------------------------------

export async function updateStory(
  _prev: unknown,
  formData: FormData,
): Promise<StoryActionResponse> {
  await requireCapability("admin.system");

  const raw = {
    storyUuid: formData.get("storyUuid") as string,
    requestUuid: formData.get("requestUuid") as string | null,
    staffId: formData.get("staffId") as string | null,
    numberOfEmployees: formData.get("numberOfEmployees") as string | null,
    storyStatus: formData.get("storyStatus") as string | null,
    storyTimeSpent: formData.get("storyTimeSpent") as string | null,
  };

  const parsed = updateStorySchema.safeParse(raw);
  if (!parsed.success) {
    return { operation: "error", message: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { storyUuid, requestUuid, staffId, numberOfEmployees, storyStatus, storyTimeSpent } = parsed.data;

  const existing = await prisma.story.findUnique({
    where: { story_uuid: storyUuid },
  });
  if (!existing) {
    return { operation: "error", message: `Story not found: ${storyUuid}` };
  }

  const updateData: Record<string, unknown> = { story_last_updated_at: new Date() };
  if (requestUuid !== undefined) updateData.request_uuid = requestUuid;
  if (staffId !== undefined) updateData.staff_id = staffId || null;
  if (numberOfEmployees !== undefined) updateData.number_of_employees = numberOfEmployees || null;
  if (storyStatus !== undefined) updateData.story_status = storyStatus;
  if (storyTimeSpent !== undefined) updateData.story_time_spent = storyTimeSpent || null;

  await prisma.story.update({
    where: { story_uuid: storyUuid },
    data: updateData as any,
  });

  revalidatePath("/admin/story");
  return { operation: "success", message: "Story updated" };
}

// ---------------------------------------------------------------------------
// deleteStory
// ---------------------------------------------------------------------------

export async function deleteStory(
  storyUuid: string,
): Promise<StoryActionResponse> {
  await requireCapability("admin.system");

  const parsed = deleteStorySchema.safeParse({ storyUuid });
  if (!parsed.success) {
    return { operation: "error", message: parsed.error.issues[0]?.message ?? "Invalid story UUID" };
  }

  const existing = await prisma.story.findUnique({
    where: { story_uuid: parsed.data.storyUuid },
  });
  if (!existing) {
    return { operation: "error", message: `Story not found: ${parsed.data.storyUuid}` };
  }

  await prisma.story.delete({
    where: { story_uuid: parsed.data.storyUuid },
  });

  revalidatePath("/admin/story");
  return { operation: "success", message: "Story deleted" };
 }