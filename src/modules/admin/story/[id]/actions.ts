"use server";

import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/modules/auth/session";
import { getStorySchema, getStoryResultSchema } from "./schemas";
import type { GetStoryResult, GetStoryInput } from "./schemas";

export async function getStory(input: GetStoryInput): Promise<GetStoryResult> {
  await requireCapability("admin.read");
  const parsed = getStorySchema.safeParse(input);
  if (!parsed.success)
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid story UUID");

  const row = await prisma.story.findUnique({
    where: { story_uuid: parsed.data.storyUuid },
  });

  if (!row) {
    const result = { story: null };
    const outputParsed = getStoryResultSchema.safeParse(result);
    if (!outputParsed.success) {
      console.error(
        "[admin/story/[id]] getStory output failed:",
        outputParsed.error.issues,
      );
    }
    return result;
  }

  const result = {
    story: {
      ...row,
      staff_id: row.staff_id ?? null,
      suggestion_uuid: row.suggestion_uuid ?? null,
      is_old: row.is_old ?? null,
    },
  };

  const outputParsed = getStoryResultSchema.safeParse(result);
  if (!outputParsed.success) {
    console.error(
      "[admin/story/[id]] getStory output failed:",
      outputParsed.error.issues,
    );
  }

  return result;
}