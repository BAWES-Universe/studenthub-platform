import { describe, it, expect } from "vitest";
import {
  salaryListItemSchema,
  salaryDetailSchema,
  listSalaryResultSchema,
} from "../schemas";

// ---------------------------------------------------------------------------
// Pure logic: salary schema validation
//
// All admin actions in actions.ts use these zod schemas internally.
// Testing them separately avoids mocking prisma/session/next/cache.
// ---------------------------------------------------------------------------

const validSalaryItem = {
  staff_salary_uuid: "abc123-def456-7890",
  staff_id: 1,
  staff_name: "John Doe",
  salary: 1500.5,
  salary_currency: "KWD",
  comment: "Monthly salary",
  salary_date: "2026-06-01",
  created_at: "2026-06-01T10:00:00.000Z",
  updated_at: "2026-06-01T10:00:00.000Z",
};

const validSalaryDetail = {
  staff_salary_uuid: "abc123-def456-7890",
  staff_id: 1,
  staff_name: "John Doe",
  staff_email: "john@example.com",
  salary: 1500.5,
  salary_currency: "KWD",
  comment: "Monthly salary",
  salary_date: "2026-06-01",
  created_at: "2026-06-01T10:00:00.000Z",
  updated_at: "2026-06-01T10:00:00.000Z",
};

describe("salaryListItemSchema", () => {
  it("accepts a valid salary list item", () => {
    const result = salaryListItemSchema.safeParse(validSalaryItem);
    expect(result.success).toBe(true);
  });

  it("accepts salary with nullable fields", () => {
    const result = salaryListItemSchema.safeParse({
      staff_salary_uuid: "xyz-789",
      staff_id: null,
      staff_name: "-",
      salary: null,
      salary_currency: null,
      comment: null,
      salary_date: null,
      created_at: "2026-06-01T10:00:00.000Z",
      updated_at: "2026-06-01T10:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required uuid", () => {
    const result = salaryListItemSchema.safeParse({
      staff_name: "John",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string uuid", () => {
    const result = salaryListItemSchema.safeParse({
      ...validSalaryItem,
      staff_salary_uuid: 123,
    });
    expect(result.success).toBe(false);
  });
});

describe("salaryDetailSchema", () => {
  it("accepts a valid salary detail object", () => {
    const result = salaryDetailSchema.safeParse(validSalaryDetail);
    expect(result.success).toBe(true);
  });

  it("accepts detail with all-null optionals", () => {
    const result = salaryDetailSchema.safeParse({
      staff_salary_uuid: "abc-123",
      staff_id: null,
      staff_name: "-",
      staff_email: null,
      salary: null,
      salary_currency: null,
      comment: null,
      salary_date: null,
      created_at: null,
      updated_at: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing uuid", () => {
    const result = salaryDetailSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("listSalaryResultSchema", () => {
  it("accepts a valid result with records", () => {
    const result = listSalaryResultSchema.safeParse({
      records: [validSalaryItem],
      total: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty records array", () => {
    const result = listSalaryResultSchema.safeParse({
      records: [],
      total: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-array records", () => {
    const result = listSalaryResultSchema.safeParse({
      records: "not-an-array",
      total: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative total", () => {
    const result = listSalaryResultSchema.safeParse({
      records: [],
      total: -1,
    });
    expect(result.success).toBe(false);
  });
});
