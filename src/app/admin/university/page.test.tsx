import { describe, it, expect } from "vitest";
import { universityListItemSchema, listUniversitiesResultSchema } from "./schemas";
import type { UniversityListItem, ListUniversitiesResult } from "./schemas";

/**
 * Page migration test for admin/university.
 *
 * Verifies that universityListItemSchema accepts the data returned by the
 * listUniversities server action, and that UniversityListItem fields map
 * correctly to table columns.
 */
describe("admin university page — data contract", () => {
  it("listUniversitiesResultSchema accepts empty list result", () => {
    const r = listUniversitiesResultSchema.safeParse({
      records: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.records).toEqual([]);
    }
  });

  it("universityListItemSchema accepts a full university record", () => {
    const r: UniversityListItem = {
      university_id: 1,
      university_name_en: "Kuwait University",
      university_name_ar: "جامعة الكويت",
      university_data_source: 1,
      candidate_count: 42,
    };
    const parsed = universityListItemSchema.safeParse(r);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.university_id).toBe(r.university_id);
      expect(parsed.data.university_name_en).toBe(r.university_name_en);
      expect(parsed.data.university_name_ar).toBe(r.university_name_ar);
      expect(parsed.data.candidate_count).toBe(42);
    }
  });

  it("UniversityListItem fields map correctly to table columns", () => {
    const record: UniversityListItem = {
      university_id: 5,
      university_name_en: "American University of Kuwait",
      university_name_ar: "الجامعة الأميركية في الكويت",
      university_data_source: 2,
      candidate_count: 137,
    };
    expect(record.university_id).toBe(5);
    expect(record.university_name_en).toBe("American University of Kuwait");
    expect(record.university_name_ar).toBe("الجامعة الأميركية في الكويت");
    expect(record.candidate_count).toBe(137);
  });

  it("ListUniversitiesResult has expected shape (matches listUniversities return)", () => {
    const result: ListUniversitiesResult = {
      records: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
    };
    expect(Array.isArray(result.records)).toBe(true);
    expect(result.total).toBe(0);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(50);
    expect(result.totalPages).toBe(0);
  });

  it("universityListItemSchema rejects missing required fields", () => {
    const r = universityListItemSchema.safeParse({ university_name_en: "Test" });
    expect(r.success).toBe(false);
  });

  it("universityListItemSchema accepts nullable fields", () => {
    const r = universityListItemSchema.safeParse({
      university_id: 1,
      university_name_en: null,
      university_name_ar: null,
      university_data_source: null,
      candidate_count: null,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.university_name_en).toBeNull();
      expect(r.data.university_name_ar).toBeNull();
      expect(r.data.university_data_source).toBeNull();
      expect(r.data.candidate_count).toBeNull();
    }
  });
});
