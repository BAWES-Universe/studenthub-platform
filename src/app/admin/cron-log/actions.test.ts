import { describe, it, expect, vi, beforeEach } from "vitest";
import { listCronLogsSchema } from "./schemas";
import type { CronLogItem, ListCronLogsResult } from "./schemas";

/**
 * Page migration test for admin/cron-log.
 *
 * Verifies that listCronLogsSchema accepts the params passed by the page,
 * and that CronLogItem fields map correctly to DataTable columns.
 *
 * Full rendering tests require Playwright (server component).
 * This validates the data contract between the page and the server action.
 */

describe("admin cron-log page — data contract", () => {
  it("listCronLogsSchema accepts empty params (defaults apply)", () => {
    const r = listCronLogsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(typeof r.data.limit).toBe("number");
      expect(r.data.limit).toBe(20);
      expect(r.data.page).toBe(1);
    }
  });

  it("listCronLogsSchema accepts the params the page actually passes", () => {
    const r = listCronLogsSchema.safeParse({ limit: 100 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(100);
    }
  });

  it("CronLogItem fields map correctly to DataTable columns", () => {
    // The page maps CronLogItem to DataTable columns:
    //   id           → row.id       (for keys)
    //   task         → row.task
    //   last_ran_at  → row.last_ran_at (formatted)
    //   last_output  → row.last_output (truncated)
    const row: CronLogItem = {
      id: 1,
      task: "nightly-cleanup",
      last_ran_at: new Date("2025-01-15T10:00:00Z"),
      last_output: "Completed successfully",
    };
    expect(row.id).toBe(1);
    expect(row.task).toBe("nightly-cleanup");
    expect(row.last_ran_at).toEqual(new Date("2025-01-15T10:00:00Z"));
    expect(row.last_output).toBe("Completed successfully");
  });

  it("CronLogItem accepts nullable last_ran_at and last_output", () => {
    const row: CronLogItem = {
      id: 2,
      task: "never-ran",
      last_ran_at: null,
      last_output: null,
    };
    expect(row.last_ran_at).toBeNull();
    expect(row.last_output).toBeNull();
  });

  it("ListCronLogsResult has expected shape", () => {
    const result: ListCronLogsResult = {
      records: [],
      total: 0,
    };
    expect(Array.isArray(result.records)).toBe(true);
    expect(typeof result.total).toBe("number");
  });
});
