import { describe, it, expect } from "vitest";
import { cronLogItemSchema, listCronLogsResultSchema } from "../schemas";

describe("admin cron-log schemas", () => {
  describe("cronLogItemSchema", () => {
    it("accepts a valid cron log entry", () => {
      const r = cronLogItemSchema.safeParse({
        id: 1,
        task: "nightly-cleanup",
        last_ran_at: new Date("2025-01-15T10:00:00Z"),
        last_output: "Completed successfully",
      });
      expect(r.success).toBe(true);
    });

    it("accepts a cron log entry with nullable fields", () => {
      const r = cronLogItemSchema.safeParse({
        id: 2,
        task: "report-generation",
        last_ran_at: null,
        last_output: null,
      });
      expect(r.success).toBe(true);
    });

    it("rejects missing id", () => {
      const r = cronLogItemSchema.safeParse({
        task: "test",
        last_ran_at: null,
        last_output: null,
      });
      expect(r.success).toBe(false);
    });

    it("rejects missing task", () => {
      const r = cronLogItemSchema.safeParse({
        id: 3,
        last_ran_at: null,
        last_output: null,
      });
      expect(r.success).toBe(false);
    });
  });

  describe("listCronLogsResultSchema", () => {
    it("accepts valid list result", () => {
      const r = listCronLogsResultSchema.safeParse({
        records: [
          {
            id: 1,
            task: "cleanup",
            last_ran_at: null,
            last_output: null,
          },
        ],
        total: 1,
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.records).toHaveLength(1);
        expect(r.data.total).toBe(1);
      }
    });

    it("accepts empty records list", () => {
      const r = listCronLogsResultSchema.safeParse({
        records: [],
        total: 0,
      });
      expect(r.success).toBe(true);
    });
  });
});
