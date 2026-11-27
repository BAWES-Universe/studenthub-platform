// M-2 copy step: the staging side. The staging object bucket (R2, S3 API) and the staging table
// `legacy_candidate_documents` (migration 0660), behind m2-copy's ports.
//
// Bucket:
// - Keys must be staging keys (`legacy-import/<generation>/<id>/<kind>/<sha256>`); anything else
//   is refused before a request is sent.
// - Writes are create-only: PutObject with If-None-Match: * and Content-MD5. A 412 means the key
//   already holds an object, answered as "exists" (never replaced); the copy core then reads it
//   back and verifies it. No delete, copy, ACL or presigned URL exists here.
// - Reads are the same bounded, ranged GetObject as the legacy reader (rangedRead).
// - List is ListObjectsV2 under one generation's prefix, paginated, keys only.
// - Bucket, account and credential come from the staging host's environment. The bucket must be
//   the one recorded on the import target and must differ from legacy's and the live document
//   bucket (checked by the run step). Errors leave as a fixed message.
//
// Table: get and insert only. Insert is ON CONFLICT DO NOTHING; a row is never updated or deleted.

import { createHash } from "node:crypto";

import { ListObjectsV2Command, PutObjectCommand, S3Client, type GetObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";

import { rangedRead, type GetObjectSender } from "./m2-bucket.js";
import type { DocumentStagingStore, StagedDocument, StagingObjects } from "./m2-copy.js";
import type { DocumentKind } from "./m2-documents.js";

const STAGING_KEY = /^legacy-import\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[1-9][0-9]{0,17}\/(?:personal-photo|resume|civil-id-front|civil-id-back)\/[0-9a-f]{64}$/;
const STAGING_PREFIX = /^legacy-import\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/$/;
export const STAGING_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const ACCOUNT = /^[a-f0-9]{32}$/;

export interface StagingBucketConfig {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly timeoutMs?: number;
}

/** The SDK calls this adapter makes. */
export interface StagingSender {
  send(command: GetObjectCommand | PutObjectCommand | ListObjectsV2Command, options: { abortSignal: AbortSignal }): Promise<unknown>;
}

const failed = () => new Error("m2.staging.failed");
const statusOf = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;

export function stagingBucket(config: StagingBucketConfig, client?: StagingSender): StagingObjects {
  if (!ACCOUNT.test(config.accountId) || !STAGING_BUCKET.test(config.bucket) || !config.accessKeyId || !config.secretAccessKey) {
    throw new Error("m2.staging.config");
  }
  const timeoutMs = config.timeoutMs ?? 30_000;
  const sender: StagingSender = client ?? new S3Client({
    region: "auto", endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`, forcePathStyle: true, maxAttempts: 2,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
  });
  const within = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    try { return await fn(deadline.signal); } finally { clearTimeout(timer); }
  };
  const read = rangedRead(sender as GetObjectSender, config.bucket, timeoutMs, (key) => STAGING_KEY.test(key));
  return {
    async read(key, maxBytes) {
      try { return await read(key, maxBytes); } catch { throw failed(); }
    },
    async put(key, bytes, mime) {
      if (!STAGING_KEY.test(key) || !Buffer.isBuffer(bytes) || bytes.length < 1) throw failed();
      try {
        await within((abortSignal) => sender.send(new PutObjectCommand({
          Bucket: config.bucket, Key: key, Body: bytes, ContentLength: bytes.length, ContentType: mime,
          ContentMD5: createHash("md5").update(bytes).digest("base64"), CacheControl: "private, no-store", IfNoneMatch: "*",
        }), { abortSignal }));
        return "written";
      } catch (error) {
        // The key already holds an object: never replaced; the caller reads it back and verifies it.
        if (statusOf(error) === 412) return "exists";
        throw failed();
      }
    },
    async list(prefix, page) {
      // One page, in key order, after `page.after`: the copy core bounds how many pages it reads.
      if (!STAGING_PREFIX.test(prefix) || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 1000
        || (page.after !== undefined && !page.after.startsWith(prefix))) throw failed();
      try {
        const listed = await within((abortSignal) => sender.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, MaxKeys: page.limit,
          ...(page.after === undefined ? {} : { StartAfter: page.after }) }), { abortSignal })) as { Contents?: { Key?: unknown }[]; IsTruncated?: boolean };
        const keys = (listed.Contents ?? []).map((item) => item.Key);
        if (!keys.every((k): k is string => typeof k === "string") || keys.length > page.limit || (listed.IsTruncated && keys.length === 0)) throw failed();
        return listed.IsTruncated ? { keys, next: keys[keys.length - 1]! } : { keys };
      } catch { throw failed(); }
    },
  };
}

/** The staging table through a pool (or a pinned client). Get and create-only insert; never update or delete. */
export function postgresDocumentStaging(db: Pick<pg.Pool, "query">): DocumentStagingStore {
  return {
    async get(legacyId, kind, generation) {
      const { rows } = await db.query<{ mime: StagedDocument["mime"]; size: number; sha256: string; object_key: string }>(
        `SELECT mime, size, sha256, object_key FROM legacy_candidate_documents
          WHERE legacy_candidate_id = $1 AND kind = $2 AND generation = $3`, [legacyId, kind, generation]);
      const r = rows[0];
      return r ? { legacyId, kind: kind as DocumentKind, generation, mime: r.mime, size: Number(r.size), sha256: r.sha256, objectKey: r.object_key } : null;
    },
    async insert(row, invocations) {
      const { rowCount } = await db.query(
        `INSERT INTO legacy_candidate_documents
           (legacy_candidate_id, kind, generation, mime, size, sha256, object_key, doccheck_invocation, copy_invocation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
        [row.legacyId, row.kind, row.generation, row.mime, row.size, row.sha256, row.objectKey, invocations.doccheck, invocations.copy]);
      return rowCount === 1 ? "inserted" : "exists";
    },
  };
}
