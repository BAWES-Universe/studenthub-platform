import { describe, it, expect } from "vitest";
import {
  emailCampaignListItemSchema,
  listEmailCampaignsResultSchema,
  listEmailCampaignsSchema,
  getEmailCampaignSchema,
} from "@/modules/email-campaigns/schemas";

const validListItem = {
  campaign_uuid: "cmp-abc-123-def",
  subject: "Summer Internship Campaign 2025",
  message: null,
  progress: 50,
  trigger_date_time: "2025-06-15T10:00:00.000Z",
  last_trigger_date_time: null,
  is_recurring: false,
  trigger_period: null,
  target: "both",
  status: true,
  created_at: "2025-06-01T08:00:00.000Z",
  updated_at: "2025-06-15T10:30:00.000Z",
};

const validDetailItem = {
  campaign_uuid: "cmp-abc-123-def",
  subject: "Summer Internship Campaign 2025",
  message: "<p>Dear candidate, ...</p>",
  progress: 50,
  trigger_date_time: new Date("2025-06-15T10:00:00Z"),
  last_trigger_date_time: null,
  is_recurring: false,
  trigger_period: null,
  target: "both",
  status: true,
  created_at: new Date("2025-06-01T08:00:00Z"),
  updated_at: new Date("2025-06-15T10:30:00Z"),
};

describe("emailCampaignListItemSchema", () => {
  it("accepts a valid email campaign list item", () => {
    const result = emailCampaignListItemSchema.safeParse(validListItem);
    expect(result.success).toBe(true);
  });

  it("accepts null optional fields", () => {
    const result = emailCampaignListItemSchema.safeParse({
      ...validListItem,
      subject: null,
      message: null,
      progress: null,
      trigger_date_time: null,
      last_trigger_date_time: null,
      is_recurring: null,
      trigger_period: null,
      target: null,
      status: null,
      created_at: null,
      updated_at: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing campaign_uuid", () => {
    const { campaign_uuid, ...rest } = validListItem;
    const result = emailCampaignListItemSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects non-string campaign_uuid", () => {
    const result = emailCampaignListItemSchema.safeParse({
      ...validListItem,
      campaign_uuid: 123,
    });
    expect(result.success).toBe(false);
  });
});

describe("listEmailCampaignsResultSchema", () => {
  it("accepts a valid result with records", () => {
    const result = listEmailCampaignsResultSchema.safeParse({
      records: [validListItem],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty records array", () => {
    const result = listEmailCampaignsResultSchema.safeParse({
      records: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative total", () => {
    const result = listEmailCampaignsResultSchema.safeParse({
      records: [],
      total: -1,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive page", () => {
    const result = listEmailCampaignsResultSchema.safeParse({
      records: [],
      total: 0,
      page: 0,
      limit: 20,
      totalPages: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("listEmailCampaignsSchema", () => {
  it("accepts empty params (defaults apply)", () => {
    const r = listEmailCampaignsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(20);
      expect(r.data.page).toBe(1);
    }
  });

  it("accepts custom limit", () => {
    const r = listEmailCampaignsSchema.safeParse({ limit: 100 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(100);
  });

  it("rejects limit > 100", () => {
    const r = listEmailCampaignsSchema.safeParse({ limit: 200 });
    expect(r.success).toBe(false);
  });

  it("accepts search parameter", () => {
    const r = listEmailCampaignsSchema.safeParse({ search: "summer" });
    expect(r.success).toBe(true);
  });
});

describe("getEmailCampaignSchema", () => {
  it("accepts a valid UUID", () => {
    const r = getEmailCampaignSchema.safeParse({ campaignUuid: "cmp-abc-123" });
    expect(r.success).toBe(true);
  });

  it("rejects empty UUID", () => {
    const r = getEmailCampaignSchema.safeParse({ campaignUuid: "" });
    expect(r.success).toBe(false);
  });
});
