/**
 * S3/MinIO file upload service.
 *
 * Provides S3-compatible upload/download/delete operations using @aws-sdk/client-s3.
 * Falls back to local disk storage when S3 is not configured/available.
 *
 * Env vars:
 *   S3_ENDPOINT          - S3 endpoint URL (e.g. http://127.0.0.1:9000 for MinIO)
 *   S3_REGION            - AWS region (default: us-east-1)
 *   S3_ACCESS_KEY        - Access key ID
 *   S3_SECRET_KEY        - Secret access key
 *   S3_BUCKET            - Bucket name
 *   S3_PUBLIC_URL_BASE   - Public URL base for accessing files
 */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  ListBucketsCommand,
} from "@aws-sdk/client-s3";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const config = {
  endpoint: process.env.S3_ENDPOINT || "",
  region: process.env.S3_REGION || "us-east-1",
  accessKey: process.env.S3_ACCESS_KEY || "",
  secretKey: process.env.S3_SECRET_KEY || "",
  bucket: process.env.S3_BUCKET || "studenthub-uploads",
  publicUrlBase: process.env.S3_PUBLIC_URL_BASE || "",
};

const LOCAL_UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "candidates");

/** Whether S3/MinIO is configured with all required credentials. */
const s3Configured = Boolean(config.endpoint && config.accessKey && config.secretKey && config.bucket);

// ---------------------------------------------------------------------------
// S3 Client
// ---------------------------------------------------------------------------

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: true, // Required for MinIO
    });
  }
  return s3Client;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface UploadResult {
  url: string;
  key: string;
  storage: "s3" | "local";
}

/**
 * Upload a file buffer to S3 (or local disk as fallback).
 *
 * @param buffer    File contents as Buffer
 * @param folder    Subfolder within the uploads root (e.g. "candidates/123")
 * @param filename  Original filename (used to derive extension)
 * @param prefix    Optional prefix for the stored filename (e.g. "photo", "cv")
 * @returns         UploadResult with public URL, storage key, and type
 */
export async function uploadFile(
  buffer: Buffer,
  folder: string,
  filename: string,
  prefix?: string,
): Promise<UploadResult> {
  const ext = path.extname(filename).toLowerCase();
  const uniqueName = prefix ? `${prefix}_${crypto.randomUUID()}${ext}` : `${crypto.randomUUID()}${ext}`;
  const key = `${folder}/${uniqueName}`;

  if (s3Configured) {
    return uploadToS3(buffer, key);
  }

  return uploadToLocal(buffer, folder, uniqueName);
}

async function uploadToS3(buffer: Buffer, key: string): Promise<UploadResult> {
  const client = getS3Client();

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: buffer,
    }),
  );

  const url = config.publicUrlBase
    ? `${config.publicUrlBase.replace(/\/+$/, "")}/${key}`
    : `${config.endpoint.replace(/\/+$/, "")}/${config.bucket}/${key}`;

  return { url, key, storage: "s3" };
}

async function uploadToLocal(buffer: Buffer, folder: string, uniqueName: string): Promise<UploadResult> {
  const dir = path.join(LOCAL_UPLOAD_DIR, folder.replace("candidates/", ""));
  await fs.mkdir(dir, { recursive: true });

  const filepath = path.join(dir, uniqueName);
  await fs.writeFile(filepath, buffer);

  const url = `/uploads/candidates/${folder.replace("candidates/", "")}/${uniqueName}`;
  const s3key = `${folder}/${uniqueName}`;
  return { url, key: s3key, storage: "local" };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a file by its storage key.
 *
 * @param key      Storage key (e.g. "candidates/123/photo_uuid.pdf")
 * @param storage  Type of storage ("s3" or "local")
 */
export async function deleteFile(key: string, storage: "s3" | "local"): Promise<void> {
  if (storage === "s3") {
    const client = getS3Client();
    await client.send(
      new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }),
    );
  } else {
    const filepath = path.join(LOCAL_UPLOAD_DIR, key.replace("candidates/", ""));
    await fs.unlink(filepath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

export interface S3Health {
  configured: boolean;
  reachable: boolean;
  buckets: string[];
  error?: string;
}

/**
 * Check if S3/MinIO is reachable and list available buckets.
 */
export async function checkS3Health(): Promise<S3Health> {
  if (!s3Configured) {
    return { configured: false, reachable: false, buckets: [] };
  }

  try {
    const client = getS3Client();
    const { Buckets } = await client.send(new ListBucketsCommand({}));
    const names = (Buckets || []).map((b: { Name?: string }) => b.Name || "").filter(Boolean);
    return {
      configured: true,
      reachable: true,
      buckets: names,
    };
  } catch (e) {
    return {
      configured: true,
      reachable: false,
      buckets: [],
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

// ---------------------------------------------------------------------------
// Ensure bucket exists (call at startup)
// ---------------------------------------------------------------------------

/**
 * Ensure the configured S3 bucket exists, creating it if necessary.
 */
export async function ensureBucket(): Promise<void> {
  if (!s3Configured) return;

  const client = getS3Client();
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  }
}
