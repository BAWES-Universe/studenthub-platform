import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  uploadFile,
  checkS3Health,
  ensureBucket,
  deleteFile,
} from "./s3";

// ---------------------------------------------------------------------------
// S3 upload service — unit tests
//
// Tests cover:
// 1. Local disk fallback (always available, no env vars needed)
// 2. uploadFile returns correct result shape
// 3. S3 health check returns configured:false when no env vars
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.S3_ENDPOINT;
  delete process.env.S3_ACCESS_KEY;
  delete process.env.S3_SECRET_KEY;
  delete process.env.S3_BUCKET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// uploadFile — local disk fallback
// ---------------------------------------------------------------------------

describe("uploadFile (local fallback)", () => {
  it("returns a result with url, key, and storage type", async () => {
    const buffer = Buffer.from("test file content");
    const result = await uploadFile(buffer, "test-folder", "test.pdf", "cv");

    expect(result).toHaveProperty("url");
    expect(result).toHaveProperty("key");
    expect(result.storage).toBe("local");
    expect(result.url).toContain("/uploads/candidates/test-folder/");
    expect(result.key).toContain("test-folder/");
  });

  it("generates unique filenames with correct extension", async () => {
    const buffer = Buffer.from("hello");
    const r1 = await uploadFile(buffer, "folder", "doc.pdf", "photo");
    const r2 = await uploadFile(buffer, "folder", "doc.pdf", "photo");

    // Different runs produce different UUIDs
    expect(r1.key).not.toBe(r2.key);
    // Both end with .pdf
    expect(r1.key).toMatch(/\.pdf$/);
    expect(r2.key).toMatch(/\.pdf$/);
    // Both contain the prefix
    expect(r1.key).toContain("photo_");
    expect(r2.key).toContain("photo_");
  });

  it("handles filenames without extensions", async () => {
    const buffer = Buffer.from("no extension");
    const result = await uploadFile(buffer, "folder", "README", "doc");

    expect(result.key).toMatch(/^folder\/doc_/);
    expect(result.key).not.toContain(".README");
  });
});

// ---------------------------------------------------------------------------
// checkS3Health — not configured
// ---------------------------------------------------------------------------

describe("checkS3Health", () => {
  it("returns configured:false when no env vars are set", async () => {
    const health = await checkS3Health();
    expect(health.configured).toBe(false);
    expect(health.reachable).toBe(false);
    expect(health.buckets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ensureBucket — no-op when not configured
// ---------------------------------------------------------------------------

describe("ensureBucket", () => {
  it("does not throw when S3 is not configured", async () => {
    await expect(ensureBucket()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deleteFile — local fallback (no error for missing files)
// ---------------------------------------------------------------------------

describe("deleteFile (local)", () => {
  it("does not throw when file does not exist", async () => {
    await expect(
      deleteFile("nonexistent/file.pdf", "local"),
    ).resolves.toBeUndefined();
  });
});
