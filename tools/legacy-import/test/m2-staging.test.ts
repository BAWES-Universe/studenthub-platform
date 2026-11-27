import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";

import { stagingBucket, type StagingSender } from "../src/m2-staging.js";

const GEN = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const KEY = `legacy-import/${GEN}/31/personal-photo/${"a".repeat(64)}`;
const SIG = new AbortController().signal;
const config = { accountId: "0".repeat(32), bucket: "sh-staging-legacy-docs", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "Secret-key" };

function fakeS3(objects = new Map<string, Buffer>(), opts: { putError?: unknown } = {}) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const sender: StagingSender = {
    async send(command) {
      const input = command.input as unknown as Record<string, unknown>;
      sent.push({ name: command.constructor.name, input });
      if (command instanceof PutObjectCommand) {
        if (opts.putError) throw opts.putError;
        if (input.IfNoneMatch !== "*") throw new Error("must be create-only");
        if (objects.has(input.Key as string)) throw Object.assign(new Error("PreconditionFailed"), { $metadata: { httpStatusCode: 412 } });
        objects.set(input.Key as string, Buffer.from(input.Body as Buffer));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const o = objects.get(input.Key as string);
        if (!o) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        const max = Number(/bytes=0-(\d+)/.exec(String(input.Range))![1]);
        const part = o.subarray(0, max + 1);
        return { Body: Readable.from([part]), ContentLength: part.length, ContentRange: `bytes 0-${part.length - 1}/${o.length}` };
      }
      if (command instanceof ListObjectsV2Command) {
        const keys = [...objects.keys()].filter((k) => k.startsWith(String(input.Prefix)) && (input.StartAfter === undefined || k > String(input.StartAfter))).sort();
        const size = Number(input.MaxKeys);
        return { Contents: keys.slice(0, size).map((Key) => ({ Key })), IsTruncated: keys.length > size };
      }
      throw new Error("unexpected command");
    },
  };
  return { sender, sent, objects };
}

test("puts are create-only with a content MD5; an existing key answers exists and is never replaced", async () => {
  const s3 = fakeS3();
  const bucket = stagingBucket(config, s3.sender);
  const bytes = Buffer.from("png bytes");
  assert.equal(await bucket.put(KEY, bytes, "image/png", SIG), "written");
  const put = s3.sent[0]!;
  assert.equal(put.name, "PutObjectCommand");
  assert.deepEqual([put.input.Bucket, put.input.IfNoneMatch, put.input.ContentMD5, put.input.CacheControl],
    [config.bucket, "*", createHash("md5").update(bytes).digest("base64"), "private, no-store"]);
  assert.equal(await bucket.put(KEY, Buffer.from("other"), "image/png", SIG), "exists");
  assert.ok(s3.objects.get(KEY)!.equals(bytes), "never replaced");
  const failing = stagingBucket(config, fakeS3(new Map(), { putError: Object.assign(new Error("Secret detail"), { $metadata: { httpStatusCode: 500 } }) }).sender);
  await assert.rejects(failing.put(KEY, bytes, "image/png", SIG), (e: Error) => e.message === "m2.staging.failed");
});

test("reads are bounded ranged reads of staging keys only; lists one bounded page of one generation's prefix at a time", async () => {
  const KEY2 = `legacy-import/${GEN}/32/resume/${"b".repeat(64)}`;
  const s3 = fakeS3(new Map([[KEY, Buffer.from("12345")], [KEY2, Buffer.from("x")]]));
  const bucket = stagingBucket(config, s3.sender);
  assert.deepEqual(await bucket.read(KEY, 10, SIG), { kind: "found", bytes: Buffer.from("12345") });
  assert.deepEqual(await bucket.read(KEY, 4, SIG), { kind: "tooLarge" });
  assert.deepEqual(await bucket.read(`legacy-import/${GEN}/31/resume/${"c".repeat(64)}`, 10, SIG), { kind: "missing" });
  const first = await bucket.list(`legacy-import/${GEN}/`, { limit: 1 }, SIG);
  assert.deepEqual(first, { keys: [KEY], next: KEY });
  assert.deepEqual(await bucket.list(`legacy-import/${GEN}/`, { after: first.next!, limit: 1 }, SIG), { keys: [KEY2] });
  assert.deepEqual(s3.sent.filter((c) => c.name === "ListObjectsV2Command").map((c) => [c.input.MaxKeys, c.input.StartAfter]), [[1, undefined], [1, KEY]]);
  const before = s3.sent.length;
  for (const bad of ["photos/Secret.png", `legacy-import/${GEN}/31/personal-photo/../x`, `legacy-import/not-a-uuid/31/resume/${"a".repeat(64)}`]) {
    await assert.rejects(bucket.read(bad, 10, SIG));
    await assert.rejects(bucket.put(bad, Buffer.from("x"), "image/png", SIG));
  }
  await assert.rejects(bucket.list("legacy-import/", { limit: 10 }, SIG));
  await assert.rejects(bucket.list("photos/", { limit: 10 }, SIG));
  await assert.rejects(bucket.list(`legacy-import/${GEN}/`, { limit: 1001 }, SIG));
  await assert.rejects(bucket.list(`legacy-import/${GEN}/`, { after: "photos/Secret.png", limit: 10 }, SIG));
  assert.equal(s3.sent.length, before, "no request for a refused key or prefix");
});

test("configuration is validated and errors never carry a detail", () => {
  for (const bad of [{ accountId: "x" }, { bucket: "Bad_Bucket" }, { accessKeyId: "" }, { secretAccessKey: "" }])
    assert.throws(() => stagingBucket({ ...config, ...bad }), (e: Error) => e.message === "m2.staging.config" && !e.message.includes("Secret"));
});
