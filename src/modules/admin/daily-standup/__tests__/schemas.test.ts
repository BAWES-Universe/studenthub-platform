import { describe, it, expect } from "vitest";
import {
  dailyStandupAnswerItemSchema,
  listDailyStandupsResultSchema,
} from "../schemas";

const validAnswer = {
  answer_uuid: "abc-123-def-456",
  staff_id: 42,
  question_uuid: "q-uuid-789",
  question: "What did you work on today?",
  answer: "Worked on the admin daily-standup page.",
  created_at: new Date("2026-06-21T10:00:00Z"),
  updated_at: new Date("2026-06-21T10:30:00Z"),
};

describe("dailyStandupAnswerItemSchema", () => {
  it("accepts a valid answer with all fields", () => {
    const result = dailyStandupAnswerItemSchema.safeParse(validAnswer);
    expect(result.success).toBe(true);
  });

  it("accepts an answer with nullable fields", () => {
    const minimal = {
      answer_uuid: "abc-123",
      staff_id: null,
      question_uuid: null,
      question: null,
      answer: null,
      created_at: null,
      updated_at: null,
    };
    const result = dailyStandupAnswerItemSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("rejects missing answer_uuid", () => {
    const result = dailyStandupAnswerItemSchema.safeParse({
      ...validAnswer,
      answer_uuid: undefined,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string answer_uuid", () => {
    const result = dailyStandupAnswerItemSchema.safeParse({
      ...validAnswer,
      answer_uuid: 123,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-number staff_id", () => {
    const result = dailyStandupAnswerItemSchema.safeParse({
      ...validAnswer,
      staff_id: "abc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-date created_at", () => {
    const result = dailyStandupAnswerItemSchema.safeParse({
      ...validAnswer,
      created_at: "not-a-date",
    });
    expect(result.success).toBe(false);
  });
});

describe("listDailyStandupsResultSchema", () => {
  it("accepts a valid paginated result", () => {
    const result = listDailyStandupsResultSchema.safeParse({
      records: [validAnswer],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty records array", () => {
    const result = listDailyStandupsResultSchema.safeParse({
      records: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative total", () => {
    const result = listDailyStandupsResultSchema.safeParse({
      records: [],
      total: -1,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero page", () => {
    const result = listDailyStandupsResultSchema.safeParse({
      records: [],
      total: 0,
      page: 0,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(false);
  });
});
