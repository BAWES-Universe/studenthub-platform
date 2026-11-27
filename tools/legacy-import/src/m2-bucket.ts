// M-2 documents: the read-only adapter for legacy's permanent bucket (the S3 bucket legacy's
// resourceManager writes to), behind m2-document-check's LegacyObjectReader port.
//
// - Only GetObject is ever sent: no list, put, copy, delete, ACL or presigned URL exists here.
// - Each read asks for `bytes=0-<maxBytes>`, so the store sends at most maxBytes + 1 bytes, and
//   the stream is cut as soon as more than maxBytes arrive whatever the store sends. An object
//   whose full size (Content-Range total) is over maxBytes is `tooLarge` without reading it all.
//   Below the limit an answer must be the whole object from offset 0: a malformed, nonzero or
//   partial Content-Range, or a full answer without a length, is a failed read.
// - One deadline covers the request and draining its body, so a stalled body fails the read.
// - Only NoSuchKey is `missing`. Anything else, including a 403 or NoSuchBucket, is a failed read: S3
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

/** `bytes 0-<last>/<total>` with last < total, or null when the header is malformed or not from offset 0. */
function rangeFrom(range: string): { readonly last: number; readonly total: number } | null {
  const m = /^bytes 0-(\d{1,16})\/(\d{1,16})$/.exec(range);
  if (!m) return null;
  const last = Number(m[1]), total = Number(m[2]);
  return Number.isSafeInteger(last) && Number.isSafeInteger(total) && last < total ? { last, total } : null;
}

/** Resolves when the signal aborts; never rejects. */
const aborted = (signal: AbortSignal) => new Promise<"aborted">((resolve) => {
  if (signal.aborted) resolve("aborted"); else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
});

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
    async read(key: string, maxBytes: number, signal?: AbortSignal): Promise<LegacyObjectRead> {
      if (!isLegacyDocumentKey(key) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw failed();
      // One deadline for the request and for draining its body. The timer is a live handle, so a
      // stalled read always ends, and it is cleared when the read settles. A caller's signal aborts it too.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), timeoutMs);
      try { return await readWithin(key, maxBytes, signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal); } finally { clearTimeout(timer); }
    },
  };

  async function readWithin(key: string, maxBytes: number, signal: AbortSignal): Promise<LegacyObjectRead> {
    let result: Awaited<ReturnType<GetObjectSender["send"]>>;
    try {
      result = await sender.send(new GetObjectCommand({ Bucket: config.bucket, Key: key, Range: `bytes=0-${maxBytes}` }), { abortSignal: signal });
    } catch (error) {
      // Only an absent object is missing: an absent bucket or any other answer is a failure.
      if (nameOf(error) === "NoSuchKey") return { kind: "missing" };
      // A zero-byte object cannot satisfy a range: it exists and is empty.
      if (statusOf(error) === 416 || nameOf(error) === "InvalidRange") return { kind: "found", bytes: Buffer.alloc(0) };
      throw failed();
    }
    const body = result.Body;
    // A ranged answer must start at offset 0 and state the whole object's size.
    let range: { readonly last: number; readonly total: number } | null = null;
    if (result.ContentRange !== undefined) {
      range = typeof result.ContentRange === "string" ? rangeFrom(result.ContentRange) : null;
      if (range === null) { destroy(body); throw failed(); }
      if (range.total > maxBytes) { destroy(body); return { kind: "tooLarge" }; }
      // Under the limit the requested range covers the whole object, so the answer must too.
      if (range.last !== range.total - 1) { destroy(body); throw failed(); }
    } else if (!Number.isSafeInteger(result.ContentLength) || result.ContentLength! < 0) {
      // A full (unranged) answer must say how long the object is.
      destroy(body); throw failed();
    }
    if (!body || typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") { destroy(body); throw failed(); }
    const chunks: Buffer[] = [];
    let size = 0;
    const iterator = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    const stop = aborted(signal);
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), stop]);
        if (next === "aborted") throw failed();
        if (next.done) break;
        size += next.value.length;
        if (size > maxBytes) { destroy(body); return { kind: "tooLarge" }; }
        chunks.push(Buffer.from(next.value));
      }
    } catch { destroy(body); throw failed(); }
    // The bytes must be the whole object.
    const expected = range ? range.total : result.ContentLength!;
    if (expected !== size) throw failed();
    return { kind: "found", bytes: Buffer.concat(chunks, size) };
  }
}
