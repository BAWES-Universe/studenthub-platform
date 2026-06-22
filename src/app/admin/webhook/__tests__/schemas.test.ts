import { describe, it, expect } from "vitest";
import {
  webhookListItemSchema,
  listWebhooksResultSchema,
  webhookDetailSchema,
  webhookCreateInputSchema,
  webhookCreateResultSchema,
} from "../schemas";

const validWebhookListItem = {
  id: 1,
  event: "candidate.created",
  endpoint: "https://example.com/hook",
  method: "POST",
  created: "2025-01-15 10:30:00",
  updated: "2025-01-15 10:30:00",
};

const validWebhookDetail = {
  webhook_id: 1,
  event: "candidate.created",
  endpoint: "https://example.com/hook",
  method: "POST",
  created_at: new Date("2025-01-15"),
  updated_at: new Date("2025-01-15"),
};

describe("webhookListItemSchema", () => {
  it("accepts a valid webhook list item", () => {
    const result = webhookListItemSchema.safeParse(validWebhookListItem);
    expect(result.success).toBe(true);
  });

  it("rejects missing id", () => {
    const { id, ...rest } = validWebhookListItem;
    const result = webhookListItemSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing required event", () => {
    const { event, ...rest } = validWebhookListItem;
    const result = webhookListItemSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects non-string event", () => {
    const result = webhookListItemSchema.safeParse({
      ...validWebhookListItem,
      event: 123,
    });
    expect(result.success).toBe(false);
  });
});

describe("listWebhooksResultSchema", () => {
  it("accepts an array of valid webhook list items", () => {
    const result = listWebhooksResultSchema.safeParse([validWebhookListItem]);
    expect(result.success).toBe(true);
  });

  it("accepts an empty array", () => {
    const result = listWebhooksResultSchema.safeParse([]);
    expect(result.success).toBe(true);
  });

  it("rejects non-array input", () => {
    const result = listWebhooksResultSchema.safeParse(validWebhookListItem);
    expect(result.success).toBe(false);
  });
});

describe("webhookDetailSchema", () => {
  it("accepts a valid webhook detail object", () => {
    const result = webhookDetailSchema.safeParse(validWebhookDetail);
    expect(result.success).toBe(true);
  });

  it("accepts null optional fields", () => {
    const result = webhookDetailSchema.safeParse({
      ...validWebhookDetail,
      method: null,
      created_at: null,
      updated_at: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required webhook_id", () => {
    const { webhook_id, ...rest } = validWebhookDetail;
    const result = webhookDetailSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects non-number webhook_id", () => {
    const result = webhookDetailSchema.safeParse({
      ...validWebhookDetail,
      webhook_id: "abc",
    });
    expect(result.success).toBe(false);
  });
});

describe("webhookCreateInputSchema", () => {
  it("accepts valid create input", () => {
    const result = webhookCreateInputSchema.safeParse({
      event: "candidate.updated",
      endpoint: "https://hooks.example.com/callback",
    });
    expect(result.success).toBe(true);
  });

  it("accepts create input with optional method", () => {
    const result = webhookCreateInputSchema.safeParse({
      event: "candidate.updated",
      endpoint: "https://hooks.example.com/callback",
      method: "PUT",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty event", () => {
    const result = webhookCreateInputSchema.safeParse({
      event: "",
      endpoint: "https://hooks.example.com/callback",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing event", () => {
    const result = webhookCreateInputSchema.safeParse({
      endpoint: "https://hooks.example.com/callback",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing endpoint", () => {
    const result = webhookCreateInputSchema.safeParse({
      event: "candidate.created",
    });
    expect(result.success).toBe(false);
  });
});

describe("webhookCreateResultSchema", () => {
  it("accepts a valid create result", () => {
    const result = webhookCreateResultSchema.safeParse({
      webhook_id: 42,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing webhook_id", () => {
    const result = webhookCreateResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects non-number webhook_id", () => {
    const result = webhookCreateResultSchema.safeParse({
      webhook_id: "abc",
    });
    expect(result.success).toBe(false);
  });
});
