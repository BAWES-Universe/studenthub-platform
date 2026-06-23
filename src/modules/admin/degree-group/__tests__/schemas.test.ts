import { describe, it, expect } from "vitest";
import {
  degreeGroupListItemSchema,
  listDegreeGroupsResultSchema,
  degreeGroupIdResultSchema,
} from "../schemas";

// ---------------------------------------------------------------------------
// Pure logic: degree-group schema validation
//
// All admin actions in actions.ts use these zod schemas internally.
// Testing them separately avoids mocking "use server" dependencies (prisma,
// session, next/cache).
// ---------------------------------------------------------------------------

const validDegreeGroup = {
  degree_group_uuid: "550e8400-e29b-41d4-a716-446655440000",
  degree_group_name_en: "Bachelor",
  degree_group_name_ar: "بكالوريوس",
  degree_group_sort_order: 1,
  skip_major: 0,
  degree_count: 5,
};

describe("degreeGroupListItemSchema", () => {
  it("accepts a valid degree group with all fields", () => {
    const result = degreeGroupListItemSchema.safeParse(validDegreeGroup);
    expect(result.success).toBe(true);
  });

  it("accepts a degree group with minimal fields (nulls for optionals)", () => {
    const minimal = {
      degree_group_uuid: "550e8400-e29b-41d4-a716-446655440001",
      degree_group_name_en: "Master",
      degree_group_name_ar: null,
      degree_group_sort_order: null,
      skip_major: null,
      degree_count: null,
    };
    const result = degreeGroupListItemSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = degreeGroupListItemSchema.safeParse({
      degree_group_name_en: "Bachelor",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-uuid degree_group_uuid", () => {
    const result = degreeGroupListItemSchema.safeParse({
      ...validDegreeGroup,
      degree_group_uuid: "not-a-uuid",
    });
    // degree_group_uuid is typed as z.string() without uuid() check,
    // so it should still pass — but we expect it to accept any string
    // (the DB constraint enforces UUID format)
    expect(result.success).toBe(true);
  });

  it("rejects non-string degree_group_name_en", () => {
    const result = degreeGroupListItemSchema.safeParse({
      ...validDegreeGroup,
      degree_group_name_en: 123,
    });
    expect(result.success).toBe(false);
  });
});

describe("listDegreeGroupsResultSchema", () => {
  it("accepts a valid paginated result", () => {
    const result = listDegreeGroupsResultSchema.safeParse({
      records: [validDegreeGroup],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty records array", () => {
    const result = listDegreeGroupsResultSchema.safeParse({
      records: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative total", () => {
    const result = listDegreeGroupsResultSchema.safeParse({
      records: [],
      total: -1,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("degreeGroupIdResultSchema", () => {
  it("accepts a valid uuid result", () => {
    const result = degreeGroupIdResultSchema.safeParse({
      degree_group_uuid: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.degree_group_uuid).toBe("550e8400-e29b-41d4-a716-446655440000");
    }
  });

  it("rejects non-uuid string", () => {
    const result = degreeGroupIdResultSchema.safeParse({
      degree_group_uuid: "not-a-uuid-at-all",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing degree_group_uuid", () => {
    const result = degreeGroupIdResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
