// M-2 documents: the read-only adapter for legacy's permanent bucket (the S3 bucket legacy's
// resourceManager writes to), behind m2-document-check's LegacyObjectReader port.
//
// - Only GetObject is ever sent: no list, put, copy, delete, ACL or presigned URL exists here.
// - Each read asks for `bytes=0-<maxBytes>`, so the store sends at most maxBytes + 1 bytes, and
//   the stream is cut as soon as more than maxBytes arrive whatever the store sends. An object
//   whose full size (Content-Range total) is over maxBytes is `tooLarge` without reading it all.
// - Only a 404 (NoSuchKey) is `missing`. Anything else, including a 403, is a failed read: S3
//   answers 403 for an absent key when the credential lacks ListBucket, and a document must not
//   be reported missing on a permission error. The read credential therefore needs GetObject and
//   ListBucket on this bucket only.
// - Keys must have the shape the M-2 mapper produces (one of legacy's three prefixes, no path
//   step, no control character); anything else is refused before a request is sent.
// - The bucket, region and credential come from the run's environment on the staging host,
//   never from the repository. Errors leave this module as a fixed message, never the SDK's.

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { LegacyObjectRead, LegacyObjectReader } from "./m2-document-check.js";

/** The prefixes the M-2 mapper builds keys under (legacy's own). */
export const LEGACY_DOCUMENT_PREFIXES = ["candidate-profile-photos/", "photos/", "candidate-resume/"] as const;

export interface LegacyBucketConfig {
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Per-read deadline, in milliseconds. */
  readonly timeoutMs?: number;
}

/** The one SDK call this adapter makes. */
export interface GetObjectSender {
  send(command: GetObjectCommand, options: { abortSignal: AbortSignal }): Promise<{
    Body?: unknown; ContentLength?: number; ContentRange?: string;
  }>;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

/** A key the mapper could have produced: a legacy prefix, then a safe relative name. */
export function isLegacyDocumentKey(key: string): boolean {
  const prefix = LEGACY_DOCUMENT_PREFIXES.find((p) => key.startsWith(p));
  if (!prefix || Buffer.byteLength(key, "utf8") > 1024 || /[\\\p{Cc}\p{Cf}]/u.test(key)) return false;
  return key.slice(prefix.length).split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const failed = () => new Error("m2.bucket.readFailed");
const destroy = (body: unknown) => { try { (body as { destroy?: () => void } | undefined)?.destroy?.(); } catch { /* already closed */ } };
const statusOf = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
const nameOf = (error: unknown) => (error as { name?: unknown } | null)?.name;

/** Total size from `bytes <first>-<last>/<total>`, or null when the header is absent or unusable. */
function totalFrom(range: string | undefined): number | null {
  const m = typeof range === "string" ? /^bytes \d+-\d+\/(\d+)$/.exec(range) : null;
  const total = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(total) ? total : null;
}

export function legacyBucketReader(config: LegacyBucketConfig, client?: GetObjectSender): LegacyObjectReader {
  if (!BUCKET.test(config.bucket) || !REGION.test(config.region) || !config.accessKeyId || !config.secretAccessKey) {
    throw new Error("m2.bucket.config");
  }
  const timeoutMs = config.timeoutMs ?? 30_000;
  const sender: GetObjectSender = client ?? new S3Client({
    region: config.region, maxAttempts: 2,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
  });

  return {
    async read(key: string, maxBytes: number): Promise<LegacyObjectRead> {
      if (!isLegacyDocumentKey(key) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw failed();
      let result: Awaited<ReturnType<GetObjectSender["send"]>>;
      try {
        result = await sender.send(new GetObjectCommand({ Bucket: config.bucket, Key: key, Range: `bytes=0-${maxBytes}` }),
          { abortSignal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        if (statusOf(error) === 404 || nameOf(error) === "NoSuchKey") return { kind: "missing" };
        // A zero-byte object cannot satisfy a range: it exists and is empty.
        if (statusOf(error) === 416 || nameOf(error) === "InvalidRange") return { kind: "found", bytes: Buffer.alloc(0) };
        throw failed();
      }
      const body = result.Body;
      const total = totalFrom(result.ContentRange);
      if (total !== null && total > maxBytes) { destroy(body); return { kind: "tooLarge" }; }
      if (!body || typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") { destroy(body); throw failed(); }
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
          size += chunk.length;
          if (size > maxBytes) { destroy(body); return { kind: "tooLarge" }; }
          chunks.push(Buffer.from(chunk));
        }
      } catch { destroy(body); throw failed(); }
      // The bytes must be the whole object: the stated total, or the stated length without a range.
      const expected = total ?? result.ContentLength;
      if (expected !== undefined && expected !== size) throw failed();
      return { kind: "found", bytes: Buffer.concat(chunks, size) };
    },
  };
}
