import { describe, it, expect } from "vitest";
import {
  settingListItemSchema,
  listSettingsResultSchema,
  settingDetailSchema,
  settingCreateResultSchema,
} from "../schemas";

// ---------------------------------------------------------------------------
// Pure logic: setting schema validation
//
// All admin actions in actions.ts use these zod schemas internally.
// Testing them separately avoids mocking "use server" dependencies (prisma,
// session, next/cache).
// ---------------------------------------------------------------------------

const validSettingListItem = {
  id: "abc-123",
  code: "general",
  key: "site_name",
  value: "StudentHub",
  serialized: "No",
  updated: "2025-01-15 10:30:00",
};

const validSettingDetail = {
  setting_uuid: "abc-123",
  code: "general",
  key: "site_name",
  value: "StudentHub",
  serialized: false,
  created_at: new Date("2025-01-01"),
  updated_at: new Date("2025-01-15"),
};

describe("settingListItemSchema", () => {
  it("accepts a valid setting list item", () => {
    const result = settingListItemSchema.safeParse(validSettingListItem);
    expect(result.success).toBe(true);
  });

  it("rejects missing required id", () => {
    const { id, ...incomplete } = validSettingListItem;
    const result = settingListItemSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  it("rejects missing required code", () => {
    const { code, ...incomplete } = validSettingListItem;
    const result = settingListItemSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  it("rejects non-string value", () => {
    const result = settingListItemSchema.safeParse({
      ...validSettingListItem,
      value: 123,
    });
    expect(result.success).toBe(false);
  });
});

describe("listSettingsResultSchema", () => {
  it("accepts an array of valid setting list items", () => {
    const result = listSettingsResultSchema.safeParse([validSettingListItem]);
    expect(result.success).toBe(true);
  });

  it("accepts an empty array", () => {
    const result = listSettingsResultSchema.safeParse([]);
    expect(result.success).toBe(true);
  });

  it("rejects non-array input", () => {
    const result = listSettingsResultSchema.safeParse(validSettingListItem);
    expect(result.success).toBe(false);
  });
});

describe("settingDetailSchema", () => {
  it("accepts a valid setting detail object", () => {
    const result = settingDetailSchema.safeParse(validSettingDetail);
    expect(result.success).toBe(true);
  });

  it("accepts null optional fields", () => {
    const result = settingDetailSchema.safeParse({
      ...validSettingDetail,
      value: null,
      serialized: null,
      created_at: null,
      updated_at: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = settingDetailSchema.safeParse({
      code: "general",
    });
    expect(result.success).toBe(false);
  });
});

describe("settingCreateResultSchema", () => {
  it("accepts a valid create result", () => {
    const result = settingCreateResultSchema.safeParse({
      uuid: "new-uuid-here",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing uuid", () => {
    const result = settingCreateResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects non-string uuid", () => {
    const result = settingCreateResultSchema.safeParse({ uuid: 123 });
    expect(result.success).toBe(false);
  });
});
