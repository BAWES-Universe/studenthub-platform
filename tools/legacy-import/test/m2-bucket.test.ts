import assert from "node:assert/strict";
import test from "node:test";
import { GetObjectCommand } from "@aws-sdk/client-s3";

import { isLegacyDocumentKey, legacyBucketReader, type GetObjectSender } from "../src/m2-bucket.js";

// Synthetic objects only. "Secret" marks a key or detail that must never leave the adapter.
const config = { bucket: "legacy-bucket", region: "eu-west-1", accessKeyId: "test-id", secretAccessKey: "test-secret" };
const MAX = 16;

type Answer = { status?: number; name?: string; body?: Buffer[] | null; range?: string; length?: number; explode?: boolean };
const sdkError = (status: number, name: string) => Object.assign(new Error("Secret detail"), { name, $metadata: { httpStatusCode: status } });

/** A fake S3 that records each command and serves `answers` by key. */
function store(answers: Record<string, Answer>) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const destroyed: string[] = [];
  const sender: GetObjectSender = {
    async send(command) {
      assert.ok(command instanceof GetObjectCommand);
      const input = command.input as unknown as Record<string, unknown>;
      sent.push({ name: command.constructor.name, input });
      const a = answers[input.Key as string];
      if (!a || a.status) throw sdkError(a?.status ?? 404, a?.name ?? "NoSuchKey");
      const key = input.Key as string;
      const body = a.body === null ? undefined : {
        async *[Symbol.asyncIterator]() { for (const c of a.body ?? []) yield c; if (a.explode) throw new Error("Secret stream detail"); },
        destroy() { destroyed.push(key); },
      };
      return { Body: body, ContentRange: a.range, ContentLength: a.length };
    },
  };
  return { reader: legacyBucketReader(config, sender), sent, destroyed };
}

test("a read is one ranged GetObject that asks for at most maxBytes + 1 bytes", async () => {
  const { reader, sent } = store({ "photos/a.png": { body: [Buffer.from("abc"), Buffer.from("de")], range: "bytes 0-4/5", length: 5 } });
  assert.deepEqual(await reader.read("photos/a.png", MAX), { kind: "found", bytes: Buffer.from("abcde") });
  assert.deepEqual(sent, [{ name: "GetObjectCommand", input: { Bucket: "legacy-bucket", Key: "photos/a.png", Range: `bytes=0-${MAX}` } }]);
});

test("only a 404 is missing; a 403 or any other failure is a failed read with a fixed message", async () => {
  const { reader } = store({ "photos/denied.png": { status: 403, name: "AccessDenied" }, "photos/busy.png": { status: 503, name: "SlowDown" } });
  assert.deepEqual(await reader.read("photos/absent.png", MAX), { kind: "missing" });
  for (const key of ["photos/denied.png", "photos/busy.png"]) {
    await assert.rejects(reader.read(key, MAX), (e: Error) => e.message === "m2.bucket.readFailed" && !String(e.stack).includes("Secret"));
  }
});

test("an object over the limit is tooLarge from its stated total, or as soon as the stream passes the limit", async () => {
  const { reader, destroyed } = store({
    "photos/big.png": { body: [Buffer.alloc(MAX + 1)], range: `bytes 0-${MAX}/${MAX * 100}` },
    "photos/liar.png": { body: [Buffer.alloc(10), Buffer.alloc(10), Buffer.alloc(10)], range: "bytes 0-9/10" },
    "photos/norange.png": { body: [Buffer.alloc(MAX), Buffer.alloc(1)] },
    "photos/exact.png": { body: [Buffer.alloc(MAX)], range: `bytes 0-${MAX - 1}/${MAX}` },
  });
  assert.deepEqual(await reader.read("photos/big.png", MAX), { kind: "tooLarge" });
  assert.deepEqual(await reader.read("photos/liar.png", MAX), { kind: "tooLarge" });
  assert.deepEqual(await reader.read("photos/norange.png", MAX), { kind: "tooLarge" });
  assert.deepEqual(await reader.read("photos/exact.png", MAX), { kind: "found", bytes: Buffer.alloc(MAX) });
  assert.deepEqual(destroyed, ["photos/big.png", "photos/liar.png", "photos/norange.png"]);
});

test("a short, broken or bodiless answer is a failed read; an empty object is found and empty", async () => {
  const { reader } = store({
    "photos/short.png": { body: [Buffer.from("abc")], range: "bytes 0-4/5" },
    "photos/short2.png": { body: [Buffer.from("abc")], length: 5 },
    "photos/broken.png": { body: [Buffer.from("abc")], explode: true },
    "photos/none.png": { body: null, range: "bytes 0-2/3" },
    "photos/empty.png": { status: 416, name: "InvalidRange" },
  });
  for (const key of ["photos/short.png", "photos/short2.png", "photos/broken.png", "photos/none.png"]) {
    await assert.rejects(reader.read(key, MAX), (e: Error) => e.message === "m2.bucket.readFailed");
  }
  assert.deepEqual(await reader.read("photos/empty.png", MAX), { kind: "found", bytes: Buffer.alloc(0) });
});

test("keys outside legacy's three prefixes or with a path step are refused before any request", async () => {
  for (const key of ["candidate-resume/My CV نور.pdf", "candidate-profile-photos/a.jpg", "photos/x/b.png"]) assert.ok(isLegacyDocumentKey(key), key);
  const bad = ["other/a.png", "photos/../Secret.png", "photos//a.png", "photos/", "photos/a\\b.png", "photos/a\n.png", "/photos/a.png", `photos/${"a".repeat(1020)}`];
  const { reader, sent } = store({});
  for (const key of bad) {
    assert.ok(!isLegacyDocumentKey(key), key);
    await assert.rejects(reader.read(key, MAX), (e: Error) => e.message === "m2.bucket.readFailed");
  }
  await assert.rejects(reader.read("photos/a.png", 0));
  assert.deepEqual(sent, []);
});

test("the configuration is checked before anything is built", () => {
  for (const bad of [{ bucket: "A_B" }, { region: "nowhere" }, { accessKeyId: "" }, { secretAccessKey: "" }]) {
    assert.throws(() => legacyBucketReader({ ...config, ...bad }), (e: Error) => e.message === "m2.bucket.config");
  }
});
