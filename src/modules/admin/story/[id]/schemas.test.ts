import { describe, it, expect } from "vitest";
import { getStorySchema, getStoryResultSchema, storyDetailItemSchema } from "./schemas";

describe("getStorySchema", () => {
  it("accepts a valid story UUID", () => {
    const result = getStorySchema.safeParse({ storyUuid: "abc-123-def" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.storyUuid).toBe("abc-123-def");
    }
  });

  it("rejects empty story UUID", () => {
    const result = getStorySchema.safeParse({ storyUuid: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing storyUuid", () => {
    const result = getStorySchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("storyDetailItemSchema", () => {
  const validItem = {
    story_uuid: "abc123-def456",
    request_uuid: "req-001",
    suggestion_uuid: null,
    staff_id: null,
    number_of_employees: 5,
    story_status: 1,
    is_old: false,
    story_time_spent: 120,
    story_created_at: new Date("2026-01-01"),
    story_last_updated_at: new Date("2026-06-01"),
  };

  it("accepts a valid detail item", () => {
    expect(storyDetailItemSchema.safeParse(validItem).success).toBe(true);
  });

  it("rejects missing story_uuid", () => {
    const { story_uuid: _, ...rest } = validItem;
    expect(storyDetailItemSchema.safeParse(rest).success).toBe(false);
  });
});

describe("getStoryResultSchema", () => {
  it("accepts a valid story result", () => {
    const result = getStoryResultSchema.safeParse({
      story: {
        story_uuid: "abc123",
        request_uuid: "req-001",
        suggestion_uuid: null,
        staff_id: null,
        number_of_employees: 5,
        story_status: 1,
        is_old: false,
        story_time_spent: 120,
        story_created_at: new Date("2026-01-01"),
        story_last_updated_at: null,
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts null story (not found)", () => {
    const result = getStoryResultSchema.safeParse({ story: null });
    expect(result.success).toBe(true);
  });
});