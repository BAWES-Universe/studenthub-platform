import assert from "node:assert/strict";
import test from "node:test";

import { buildManifest } from "../src/manifest.js";
import { canonicalize, sha256 } from "../src/canonical.js";
import { DEFAULT_SIZE, generateDataset } from "../src/generate.js";

test("the same seed produces an identical dataset and manifest", () => {
  const first = generateDataset("shu-0032");
  const second = generateDataset("shu-0032");

  assert.equal(sha256(first), sha256(second));
  assert.deepEqual(buildManifest(first), buildManifest(second));
  assert.equal(
    buildManifest(first).manifestHash,
    "19da68172db15755cc5e5b7d273e07dc68c7a8fadbb318789cdeaa9562b99688",
  );
});

test("a different seed produces a different manifest hash", () => {
  const a = buildManifest(generateDataset("seed-a"));
  const b = buildManifest(generateDataset("seed-b"));

  assert.notEqual(a.manifestHash, b.manifestHash);
});

test("canonicalisation is key-order independent", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(sha256({ b: [1, { d: 4, c: 3 }] }), sha256({ b: [1, { c: 3, d: 4 }] }));
});

test("the manifest carries counts and per-entity hashes and no clock", () => {
  const manifest = buildManifest(generateDataset("shu-0032"));

  assert.equal(manifest.counts.organizations, DEFAULT_SIZE.organizations);
  assert.equal(manifest.counts.candidates, DEFAULT_SIZE.candidates);
  assert.equal(manifest.counts.requests, DEFAULT_SIZE.requests);
  assert.ok(manifest.counts.applications <= DEFAULT_SIZE.applications);
  for (const hash of Object.values(manifest.entityHashes)) {
    assert.match(hash, /^[0-9a-f]{64}$/);
  }
  assert.equal(JSON.stringify(manifest).includes("timestamp"), false);
});

test("generated contact values cannot reach a real mailbox", () => {
  for (const candidate of generateDataset("shu-0032").candidates) {
    assert.ok(candidate.email.endsWith("@fixture.invalid"), candidate.id);
  }
});
