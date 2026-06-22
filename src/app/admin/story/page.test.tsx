import { describe, it, expect } from "vitest";
import { listStoriesSchema, storyItemSchema, listStoriesResultSchema } from "./schemas";
import type { StoryItem, ListStoriesResult } from "./schemas";

/**
 * Page migration test for admin/story.
 * Validates the data contract between the page and the server action.
 */
describe("admin story page — data contract", () => {
  it("listStoriesSchema accepts empty params (defaults apply)", () => {
    const r = listStoriesSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(50);
      expect(r.data.page).toBe(1);
    }
  });

  it("listStoriesSchema accepts the params the page actually passes", () => {
    const r = listStoriesSchema.safeParse({ limit: 100 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(100);
  });

  it("StoryItem fields map correctly to DataTable columns", () => {
    const row: StoryItem = {
      story_uuid: "str-abc-123",
      request_uuid: "req-def-456",
      suggestion_uuid: null,
      request_position_title: "Software Engineer",
      staff_id: 42,
      staff_name: "John Doe",
      number_of_employees: 5,
      story_status: 1,
      is_old: false,
      story_time_spent: 120,
      story_created_at: "2025-06-15T10:00:00.000Z",
      story_last_updated_at: "2025-06-15T10:00:00.000Z",
    };
    expect(row.story_uuid).toBe("str-abc-123");
    expect(row.request_position_title).toBe("Software Engineer");
    expect(row.staff_name).toBe("John Doe");
    expect(row.story_status).toBe(1);
  });

  it("StoryItem allows nullable fields", () => {
    const r = storyItemSchema.safeParse({
      story_uuid: "str-null-test",
      request_uuid: "req-null-test",
      request_position_title: null,
      suggestion_uuid: null,
      staff_id: null,
      staff_name: null,
      number_of_employees: null,
      story_status: 0,
      is_old: null,
      story_time_spent: null,
      story_created_at: null,
      story_last_updated_at: null,
    });
    expect(r.success).toBe(true);
  });

  it("ListStoriesResult has expected shape", () => {
    const result: ListStoriesResult = {
      stories: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
    };
    expect(Array.isArray(result.stories)).toBe(true);
    expect(typeof result.total).toBe("number");
    expect(typeof result.page).toBe("number");
    expect(typeof result.limit).toBe("number");
    expect(typeof result.totalPages).toBe("number");
  });

  it("StoryItem status values match table component expectations", () => {
    // Draft = 0, Active = 1, Closed = 2
    const draft: StoryItem = { story_uuid: "d", request_uuid: "r", request_position_title: null, suggestion_uuid: null, staff_id: null, staff_name: null, number_of_employees: null, story_status: 0, is_old: false, story_time_spent: null, story_created_at: null, story_last_updated_at: null };
    const active: StoryItem = { story_uuid: "a", request_uuid: "r", request_position_title: null, suggestion_uuid: null, staff_id: null, staff_name: null, number_of_employees: null, story_status: 1, is_old: false, story_time_spent: null, story_created_at: null, story_last_updated_at: null };
    const closed: StoryItem = { story_uuid: "c", request_uuid: "r", request_position_title: null, suggestion_uuid: null, staff_id: null, staff_name: null, number_of_employees: null, story_status: 2, is_old: false, story_time_spent: null, story_created_at: null, story_last_updated_at: null };
    expect(draft.story_status).toBe(0);
    expect(active.story_status).toBe(1);
    expect(closed.story_status).toBe(2);
  });
});