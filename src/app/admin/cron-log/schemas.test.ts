import { describe, it, expect } from "vitest";
import { cronLogItemSchema, listCronLogsResultSchema } from "./schemas";

describe("admin cron-log app-level schemas", () => {
  it("cronLogItemSchema validates correctly", () => {
    const r = cronLogItemSchema.safeParse({
      id: 1,
      task: "test-task",
      last_ran_at: new Date("2025-01-15T10:00:00Z"),
      last_output: "done",
    });
    expect(r.success).toBe(true);
  });

  it("listCronLogsResultSchema validates correctly", () => {
    const r = listCronLogsResultSchema.safeParse({
      records: [],
      total: 0,
    });
    expect(r.success).toBe(true);
  });
});
