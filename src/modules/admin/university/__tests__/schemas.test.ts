import { describe, it, expect } from "vitest";
import {
  universityListItemSchema,
  listUniversitiesResultSchema,
  universityIdResultSchema,
} from "../schemas";

const validUniversity = {
  university_id: 1,
  university_name_en: "Kuwait University",
  university_name_ar: "جامعة الكويت",
  university_data_source: 1,
  candidate_count: 42,
};

describe("universityListItemSchema", () => {
  it("accepts a valid university with all fields", () => {
    const result = universityListItemSchema.safeParse(validUniversity);
    expect(result.success).toBe(true);
  });

  it("accepts a university with minimal fields (nulls for optionals)", () => {
    const minimal = {
      university_id: 2,
      university_name_en: null,
      university_name_ar: null,
      university_data_source: null,
      candidate_count: null,
    };
    const result = universityListItemSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = universityListItemSchema.safeParse({
      university_name_en: "Test",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative university_id", () => {
    const result = universityListItemSchema.safeParse({
      ...validUniversity,
      university_id: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric university_id", () => {
    const result = universityListItemSchema.safeParse({
      ...validUniversity,
      university_id: "abc",
    });
    expect(result.success).toBe(false);
  });
});

describe("listUniversitiesResultSchema", () => {
  it("accepts a valid paginated result", () => {
    const result = listUniversitiesResultSchema.safeParse({
      records: [validUniversity],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty records array", () => {
    const result = listUniversitiesResultSchema.safeParse({
      records: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative total", () => {
    const result = listUniversitiesResultSchema.safeParse({
      records: [],
      total: -1,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("universityIdResultSchema", () => {
  it("accepts a valid id result", () => {
    const result = universityIdResultSchema.safeParse({
      university_id: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.university_id).toBe(1);
    }
  });

  it("rejects zero id", () => {
    const result = universityIdResultSchema.safeParse({
      university_id: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing university_id", () => {
    const result = universityIdResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
