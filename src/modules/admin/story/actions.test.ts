import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listStoriesSchema,
  storyItemSchema,
  listStoriesResultSchema,
} from "./schemas";
import type { StoryItem, ListStoriesResult } from "./schemas";

// ── Hoisted mock functions ──────────────────────────────────
const {
  mockRequireCapability,
  mockRevalidatePath,
  mockFindMany,
  mockCount,
  mockFindUnique,
} = vi.hoisted(() => ({
  mockRequireCapability: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockFindMany: vi.fn(),
  mockCount: vi.fn(),
  mockFindUnique: vi.fn(),
}));

// ── Mock session module ─────────────────────────────────────
vi.mock("@/modules/auth/session", () => ({
  requireCapability: mockRequireCapability,
}));

// ── Mock next/cache ─────────────────────────────────────────
vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

// ── Mock Prisma ─────────────────────────────────────────────
vi.mock("@/lib/prisma", () => ({
  prisma: {
    story: {
      findMany: mockFindMany,
      count: mockCount,
      findUnique: mockFindUnique,
    },
  },
}));

import { listStories } from "./actions";

// ---------------------------------------------------------------------------
// Input schema validation
// ---------------------------------------------------------------------------

describe("listStoriesSchema", () => {
  it("accepts empty params (default pagination)", () => {
    const result = listStoriesSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(50);
    }
  });

  it("accepts explicit pagination params", () => {
    const result = listStoriesSchema.safeParse({ page: 2, limit: 25 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(2);
      expect(result.data.limit).toBe(25);
    }
  });

  it("rejects limit over 200", () => {
    const result = listStoriesSchema.safeParse({ limit: 999 });
    expect(result.success).toBe(false);
  });

  it("rejects negative page", () => {
    const result = listStoriesSchema.safeParse({ page: -1 });
    expect(result.success).toBe(false);
  });

  it("coerces string page to number", () => {
    const result = listStoriesSchema.safeParse({ page: "3" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Output schema validation
// ---------------------------------------------------------------------------

describe("storyItemSchema", () => {
  it("accepts a valid story item", () => {
    const item: StoryItem = {
      story_uuid: "abc-123",
      request_uuid: "req-001",
      suggestion_uuid: null,
      request_position_title: null,
      staff_id: null,
      staff_name: null,
      number_of_employees: 5,
      story_status: 1,
      is_old: false,
      story_time_spent: 120,
      story_created_at: "2026-01-01T00:00:00.000Z",
      story_last_updated_at: null,
    };
    const result = storyItemSchema.safeParse(item);
    expect(result.success).toBe(true);
  });

  it("accepts nullable fields", () => {
    const item: StoryItem = {
      story_uuid: "abc-123",
      request_uuid: "req-001",
      suggestion_uuid: null,
      request_position_title: null,
      staff_id: null,
      staff_name: null,
      number_of_employees: null,
      story_status: 0,
      is_old: null,
      story_time_spent: null,
      story_created_at: null,
      story_last_updated_at: null,
    };
    const result = storyItemSchema.safeParse(item);
    expect(result.success).toBe(true);
  });

  it("rejects missing story_uuid", () => {
    const result = storyItemSchema.safeParse({
      request_uuid: "req-001",
      story_status: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("listStoriesResultSchema", () => {
  it("accepts a valid list result with items", () => {
    const result: ListStoriesResult = {
      stories: [
        {
          story_uuid: "abc-123",
          request_uuid: "req-001",
          suggestion_uuid: null,
          request_position_title: null,
          staff_id: null,
          staff_name: null,
          number_of_employees: 5,
          story_status: 1,
          is_old: false,
          story_time_spent: 120,
          story_created_at: "2026-01-01T00:00:00.000Z",
          story_last_updated_at: null,
        },
      ],
      total: 1,
      page: 1,
      limit: 50,
      totalPages: 1,
    };
    const parsed = listStoriesResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("accepts empty stories array", () => {
    const result: ListStoriesResult = {
      stories: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
    };
    const parsed = listStoriesResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("rejects non-array stories", () => {
    const result = {
      stories: "not-an-array",
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
    };
    const parsed = listStoriesResultSchema.safeParse(result);
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Action-level tests — mocked DB
// ---------------------------------------------------------------------------

describe("listStories action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns paginated list with default params", async () => {
    const dbRows = [
      {
        story_uuid: "abc-123",
        request_uuid: "req-001",
        suggestion_uuid: null,
        staff_id: null,
        number_of_employees: 5,
        story_status: 1,
        is_old: false,
        story_time_spent: 120,
        story_created_at: "2026-01-01T00:00:00.000Z",
        story_last_updated_at: null,
      },
    ];

    mockRequireCapability.mockResolvedValue({ user: { id: 1 } });
    mockFindMany.mockResolvedValue(dbRows);
    mockCount.mockResolvedValue(1);

    const result = await listStories({});

    expect(mockRequireCapability).toHaveBeenCalledWith("admin.read");
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { story_last_updated_at: "desc" },
        skip: 0,
        take: 50,
      }),
    );
    expect(result.stories).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(50);
    expect(result.totalPages).toBe(1);
  });

  it("handles pagination correctly", async () => {
    mockRequireCapability.mockResolvedValue({ user: { id: 1 } });
    mockFindMany.mockResolvedValue([]);
    mockCount.mockResolvedValue(50);

    await listStories({ page: 3, limit: 10 });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20,
        take: 10,
      }),
    );
  });

  it("returns empty result when no stories exist", async () => {
    mockRequireCapability.mockResolvedValue({ user: { id: 1 } });
    mockFindMany.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);

    const result = await listStories({});

    expect(result.stories).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(0);
  });

  it("throws when session fails", async () => {
    mockRequireCapability.mockRejectedValue(new Error("Unauthorized"));

    await expect(listStories({})).rejects.toThrow("Unauthorized");
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});