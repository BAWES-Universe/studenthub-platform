import { describe, it, expect } from "vitest";
import {
  eventItemSchema,
  listEventsResultSchema,
} from "../schemas";

// ---------------------------------------------------------------------------
// Pure logic: event schema validation
//
// All admin actions in actions.ts use these zod schemas internally.
// Testing them separately avoids mocking "use server" dependencies (prisma,
// session, next/cache).
// ---------------------------------------------------------------------------

const validEvent = {
  activity_uuid: "abc-123-def-456",
  request_uuid: "req-789-ghi",
  activity_detail: "Candidate uploaded CV document",
  staff_name: "Ahmed Al-Sabah",
  activity_created_datetime: new Date("2026-06-22T10:00:00Z"),
  activity_updated_datetime: new Date("2026-06-22T10:00:00Z"),
};

describe("eventItemSchema", () => {
  it("accepts a valid event with all fields", () => {
    const result = eventItemSchema.safeParse(validEvent);
    expect(result.success).toBe(true);
  });

  it("accepts an event with null staff_name", () => {
    const result = eventItemSchema.safeParse({
      ...validEvent,
      staff_name: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an event with nullable dates", () => {
    const result = eventItemSchema.safeParse({
      ...validEvent,
      activity_created_datetime: null,
      activity_updated_datetime: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields (no activity_uuid)", () => {
    const { activity_uuid, ...missing } = validEvent;
    const result = eventItemSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("rejects missing request_uuid", () => {
    const { request_uuid, ...missing } = validEvent;
    const result = eventItemSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("rejects missing activity_detail", () => {
    const { activity_detail, ...missing } = validEvent;
    const result = eventItemSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("rejects non-string activity_uuid", () => {
    const result = eventItemSchema.safeParse({
      ...validEvent,
      activity_uuid: 123,
    });
    expect(result.success).toBe(false);
  });
});

describe("listEventsResultSchema", () => {
  it("accepts a valid paginated result", () => {
    const result = listEventsResultSchema.safeParse({
      events: [validEvent],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty events array", () => {
    const result = listEventsResultSchema.safeParse({
      events: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative total", () => {
    const result = listEventsResultSchema.safeParse({
      events: [],
      total: -1,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing events key", () => {
    const result = listEventsResultSchema.safeParse({
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(false);
  });
});
