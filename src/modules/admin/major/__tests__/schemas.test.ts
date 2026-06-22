import { describe, it, expect } from "vitest";
import {
  majorListItemSchema,
  listMajorResultSchema,
  majorIdResultSchema,
} from "../schemas";

// ---------------------------------------------------------------------------
// Pure logic: major schema validation
// ---------------------------------------------------------------------------

const validMajor = {
  major_uuid: "550e8400-e29b-41d4-a716-446655440000",
  major_name_en: "Computer Science",
  major_name_ar: "علوم الحاسب",
  data_source: 1,
  major_created_at: "2024-01-15T00:00:00.000Z",
  major_updated_at: "2024-06-20T00:00:00.000Z",
  candidate_count: 42,
};

describe("majorListItemSchema", () => {
  it("accepts a valid major with all fields", () => {
    const result = majorListItemSchema.safeParse(validMajor);
    expect(result.success).toBe(true);
  });

  it("accepts a major with nulls for optional fields", () => {
    const minimal = {
      major_uuid: "550e8400-e29b-41d4-a716-446655440001",
      major_name_en: "Mathematics",
      major_name_ar: null,
      data_source: null,
      major_created_at: null,
      major_updated_at: null,
      candidate_count: null,
    };
    const result = majorListItemSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = majorListItemSchema.safeParse({
      major_name_en: "Physics",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string name_en", () => {
    const result = majorListItemSchema.safeParse({
      ...validMajor,
      major_name_en: 123,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric data_source", () => {
    const result = majorListItemSchema.safeParse({
      ...validMajor,
      data_source: "abc",
    });
    expect(result.success).toBe(false);
  });
});

describe("listMajorResultSchema", () => {
  it("accepts a valid paginated result", () => {
    const result = listMajorResultSchema.safeParse({
      records: [validMajor],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty records array", () => {
    const result = listMajorResultSchema.safeParse({
      records: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative total", () => {
    const result = listMajorResultSchema.safeParse({
      records: [],
      total: -1,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("majorIdResultSchema", () => {
  it("accepts a valid uuid result", () => {
    const result = majorIdResultSchema.safeParse({
      major_uuid: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.major_uuid).toBe("550e8400-e29b-41d4-a716-446655440000");
    }
  });

  it("rejects non-uuid string", () => {
    const result = majorIdResultSchema.safeParse({
      major_uuid: "not-a-uuid-at-all",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing major_uuid", () => {
    const result = majorIdResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
