import { describe, it, expect } from "vitest";
import {
  countryListItemSchema,
  listCountriesResultSchema,
  countryIdResultSchema,
} from "../schemas";

// ---------------------------------------------------------------------------
// Pure logic: country schema validation
//
// All admin actions in actions.ts use these zod schemas internally.
// Testing them separately avoids mocking "use server" dependencies (prisma,
// session, next/cache).
// ---------------------------------------------------------------------------

const validCountry = {
  country_id: 1,
  country_name_en: "Kuwait",
  country_name_ar: "الكويت",
  country_nationality_name_en: "Kuwaiti",
  country_nationality_name_ar: "كويتي",
  iso: "KWT",
  emoji: "🇰🇼",
  country_code: 965,
  currency_code: "KWD",
  country_from_google_map: false,
};

describe("countryListItemSchema", () => {
  it("accepts a valid country with all fields", () => {
    const result = countryListItemSchema.safeParse(validCountry);
    expect(result.success).toBe(true);
  });

  it("accepts a country with minimal fields (nulls for optionals)", () => {
    const minimal = {
      country_id: 2,
      country_name_en: "United Arab Emirates",
      country_name_ar: null,
      country_nationality_name_en: "Emirati",
      country_nationality_name_ar: null,
      iso: null,
      emoji: null,
      country_code: null,
      currency_code: null,
      country_from_google_map: null,
    };
    const result = countryListItemSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = countryListItemSchema.safeParse({
      country_name_en: "Kuwait",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer country_id", () => {
    const result = countryListItemSchema.safeParse({
      ...validCountry,
      country_id: "abc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string country_name_en", () => {
    const result = countryListItemSchema.safeParse({
      ...validCountry,
      country_name_en: 123,
    });
    expect(result.success).toBe(false);
  });
});

describe("listCountriesResultSchema", () => {
  it("accepts a valid paginated result", () => {
    const result = listCountriesResultSchema.safeParse({
      records: [validCountry],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty records array", () => {
    const result = listCountriesResultSchema.safeParse({
      records: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative total", () => {
    const result = listCountriesResultSchema.safeParse({
      records: [],
      total: -1,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("countryIdResultSchema", () => {
  it("accepts a valid country_id result", () => {
    const result = countryIdResultSchema.safeParse({ country_id: 42 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.country_id).toBe(42);
    }
  });

  it("rejects non-integer country_id", () => {
    const result = countryIdResultSchema.safeParse({ country_id: "abc" });
    expect(result.success).toBe(false);
  });

  it("rejects missing country_id", () => {
    const result = countryIdResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
