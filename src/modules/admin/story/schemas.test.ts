import { describe, it, expect } from "vitest";
import {
  storyItemSchema,
  listStoriesResultSchema,
  storyActionResponseSchema,
} from "./schemas";

describe("storyItemSchema", () => {
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

  it("accepts a valid story item", () => {
    expect(storyItemSchema.safeParse(validItem).success).toBe(true);
  });

  it("accepts nullable fields", () => {
    expect(
      storyItemSchema.safeParse({
        ...validItem,
        suggestion_uuid: null,
        staff_id: null,
        story_created_at: null,
        story_last_updated_at: null,
      }).success,
    ).toBe(true);
  });

  it("rejects missing story_uuid", () => {
    const { story_uuid: _, ...rest } = validItem;
    expect(storyItemSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects empty story_uuid", () => {
    expect(
      storyItemSchema.safeParse({ ...validItem, story_uuid: "" }).success,
    ).toBe(false);
  });

  it("rejects non-integer story_status", () => {
    expect(
      storyItemSchema.safeParse({ ...validItem, story_status: "not-a-number" })
        .success,
    ).toBe(false);
  });
});

describe("listStoriesResultSchema", () => {
  const validResult = {
    stories: [
      {
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
    ],
    total: 1,
    page: 1,
    limit: 50,
    totalPages: 1,
  };

  it("accepts a valid list stories result", () => {
    expect(listStoriesResultSchema.safeParse(validResult).success).toBe(true);
  });

  it("accepts empty stories array", () => {
    expect(
      listStoriesResultSchema.safeParse({
        ...validResult,
        stories: [],
        total: 0,
        totalPages: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects missing stories", () => {
    const { stories: _, ...rest } = validResult;
    expect(listStoriesResultSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects negative total", () => {
    expect(
      listStoriesResultSchema.safeParse({ ...validResult, total: -1 }).success,
    ).toBe(false);
  });

  it("rejects page 0", () => {
    expect(
      listStoriesResultSchema.safeParse({ ...validResult, page: 0 }).success,
    ).toBe(false);
  });
});

describe("storyActionResponseSchema", () => {
  it("accepts a valid action response", () => {
    expect(
      storyActionResponseSchema.safeParse({
        operation: "success",
        message: "Story updated",
      }).success,
    ).toBe(true);
  });

  it("rejects missing operation", () => {
    expect(
      storyActionResponseSchema.safeParse({ message: "Done" }).success,
    ).toBe(false);
  });

  it("rejects empty message", () => {
    expect(
      storyActionResponseSchema.safeParse({
        operation: "error",
        message: "",
      }).success,
    ).toBe(false);
  });
});