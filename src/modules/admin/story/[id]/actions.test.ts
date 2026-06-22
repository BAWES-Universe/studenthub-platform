import { describe, it, expect, vi, beforeEach } from "vitest";
import { getStorySchema, getStoryResultSchema } from "./schemas";

// ── Hoisted mock functions ──────────────────────────────────
const { mockRequireCapability, mockFindUnique } = vi.hoisted(() => ({
  mockRequireCapability: vi.fn(),
  mockFindUnique: vi.fn(),
}));

// ── Mock session module ─────────────────────────────────────
vi.mock("@/modules/auth/session", () => ({
  requireCapability: mockRequireCapability,
}));

// ── Mock Prisma ─────────────────────────────────────────────
vi.mock("@/lib/prisma", () => ({
  prisma: {
    story: {
      findUnique: mockFindUnique,
    },
  },
}));

import { getStory } from "./actions";

describe("getStorySchema", () => {
  it("accepts a valid story UUID", () => {
    const result = getStorySchema.safeParse({ storyUuid: "abc-123" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.storyUuid).toBe("abc-123");
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

describe("getStoryResultSchema", () => {
  it("accepts a valid story result", () => {
    const result = getStoryResultSchema.safeParse({
      story: {
        story_uuid: "abc-123",
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

describe("getStory action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a story by UUID", async () => {
    const dbRow = {
      story_uuid: "abc-123",
      request_uuid: "req-001",
      suggestion_uuid: null,
      staff_id: null,
      number_of_employees: 5,
      story_status: 1,
      is_old: false,
      story_time_spent: 120,
      story_created_at: new Date("2026-01-01"),
      story_last_updated_at: null,
    };

    mockRequireCapability.mockResolvedValue({ user: { id: 1 } });
    mockFindUnique.mockResolvedValue(dbRow);

    const result = await getStory({ storyUuid: "abc-123" });

    expect(mockRequireCapability).toHaveBeenCalledWith("admin.read");
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { story_uuid: "abc-123" },
    });
    expect(result.story).not.toBeNull();
    expect(result.story?.story_uuid).toBe("abc-123");
    expect(result.story?.request_uuid).toBe("req-001");
  });

  it("returns null when story not found", async () => {
    mockRequireCapability.mockResolvedValue({ user: { id: 1 } });
    mockFindUnique.mockResolvedValue(null);

    const result = await getStory({ storyUuid: "nonexistent" });

    expect(result.story).toBeNull();
  });

  it("throws when session fails", async () => {
    mockRequireCapability.mockRejectedValue(new Error("Unauthorized"));

    await expect(
      getStory({ storyUuid: "abc-123" }),
    ).rejects.toThrow("Unauthorized");
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});