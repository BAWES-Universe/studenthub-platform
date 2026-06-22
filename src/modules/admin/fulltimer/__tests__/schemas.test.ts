import { describe, it, expect } from "vitest";
import {
  fulltimerListItemSchema,
  listFulltimersResultSchema,
  fulltimerDetailSchema,
  fulltimerIdResultSchema,
} from "../schemas";

// ---------------------------------------------------------------------------
// Pure logic: fulltimer schema validation
// ---------------------------------------------------------------------------

const validFulltimerListItem = {
  fulltimer_uuid: "550e8400-e29b-41d4-a716-446655440000",
  fulltimer_name: "Khalid Al-Otaibi",
  fulltimer_email: "khalid@example.com",
  fulltimer_phone: "+965 98765432",
  country_name: "Kuwait",
  nationality_name: "Kuwaiti",
  fulltimer_employed: true,
  fulltimer_created_datetime: new Date("2025-01-01"),
  fulltimer_updated_datetime: new Date("2025-01-15"),
};

const validFulltimerDetail = {
  fulltimer_uuid: "550e8400-e29b-41d4-a716-446655440000",
  fulltimer_name: "Khalid Al-Otaibi",
  fulltimer_email: "khalid@example.com",
  fulltimer_phone: "+965 98765432",
  fulltimer_employed: true,
  fulltimer_gender: true,
  fulltimer_birth_date: new Date("2000-01-15"),
  fulltimer_driving_license: true,
  fulltimer_current_salary: "1500",
  fulltimer_expected_salary: "2500",
  currency_code: "KWD",
  country_name: "Kuwait",
  nationality_name: "Kuwaiti",
  university_name: "Kuwait University",
  area_name: "Hawalli",
  fulltimer_created_datetime: new Date("2025-01-01"),
  fulltimer_updated_datetime: new Date("2025-01-15"),
};

describe("fulltimerListItemSchema", () => {
  it("accepts a valid fulltimer list item", () => {
    const result = fulltimerListItemSchema.safeParse(validFulltimerListItem);
    expect(result.success).toBe(true);
  });

  it("accepts null optional fields", () => {
    const result = fulltimerListItemSchema.safeParse({
      fulltimer_uuid: "550e8400-e29b-41d4-a716-446655440000",
      fulltimer_name: "Khalid Al-Otaibi",
      fulltimer_email: "khalid@example.com",
      fulltimer_phone: null,
      country_name: null,
      nationality_name: null,
      fulltimer_employed: null,
      fulltimer_created_datetime: new Date(),
      fulltimer_updated_datetime: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fulltimer_uuid", () => {
    const { fulltimer_uuid, ...incomplete } = validFulltimerListItem;
    const result = fulltimerListItemSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  it("rejects missing required fulltimer_name", () => {
    const { fulltimer_name, ...incomplete } = validFulltimerListItem;
    const result = fulltimerListItemSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });
});

describe("listFulltimersResultSchema", () => {
  it("accepts a valid result with records array", () => {
    const result = listFulltimersResultSchema.safeParse({
      records: [validFulltimerListItem],
      total: 1,
      page: 1,
      limit: 50,
      totalPages: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty records array", () => {
    const result = listFulltimersResultSchema.safeParse({
      records: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
    });
    expect(result.success).toBe(true);
  });
});

describe("fulltimerDetailSchema", () => {
  it("accepts a valid detail object", () => {
    const result = fulltimerDetailSchema.safeParse(validFulltimerDetail);
    expect(result.success).toBe(true);
  });

  it("accepts null optional fields", () => {
    const result = fulltimerDetailSchema.safeParse({
      fulltimer_uuid: "550e8400-e29b-41d4-a716-446655440000",
      fulltimer_name: "Khalid Al-Otaibi",
      fulltimer_email: "khalid@example.com",
      fulltimer_phone: null,
      fulltimer_employed: null,
      fulltimer_gender: null,
      fulltimer_birth_date: null,
      fulltimer_driving_license: null,
      fulltimer_current_salary: null,
      fulltimer_expected_salary: null,
      currency_code: null,
      country_name: null,
      nationality_name: null,
      university_name: null,
      area_name: null,
      fulltimer_created_datetime: new Date(),
      fulltimer_updated_datetime: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe("fulltimerIdResultSchema", () => {
  it("accepts a valid result with uuid", () => {
    const result = fulltimerIdResultSchema.safeParse({
      fulltimer_uuid: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing fulltimer_uuid", () => {
    const result = fulltimerIdResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
