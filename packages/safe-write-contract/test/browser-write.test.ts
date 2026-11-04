import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { BrowserWriteAPI, BrowserWriteOutcome, BrowserReceiptStatus } from "../src/browser-write.js";
const sourceURL = new URL("../src/browser-write.js", import.meta.url);
const api: typeof import("../src/browser-write.js") = await import(process.env.BROWSER_TOKEN_MUTANT ?? sourceURL.href);
const binding = { principalRef: "a".repeat(64), personRef: "b".repeat(64), field: "displayName", normalizationVersion: "nfc-v1" };
const now = new Date("2026-11-04T00:00:00.000Z");
const key = "secret-key-material-32-bytes-minimum";
const factory = () => api.createBrowserWriteTokens({ activeKeyVersion: "key1", keys: { key1: key } });
const baseline = () => api.browserBaselineDigest({ persisted: { kind: "null" }, shownFallback: null });

test("BW-functional render tokens are fresh, bound, exact and contain no draft", () => {
  const f = factory();
  const t = f.issue(binding, baseline(), now);
  assert.equal(f.verify(t, binding).ok, true);
  const second = f.issue(binding, baseline(), now);
  assert.notEqual(t.tokenId, second.tokenId);
  assert.notEqual(t.tokenRef, second.tokenRef);
  assert.equal(Date.parse(t.expiresAt) - Date.parse(t.issuedAt), 300000);
  for (const [name, value] of Object.entries({ contractVersion: "2.0.0", purpose: "other", keyVersion: "key2", tokenId: "c".repeat(64), tokenRef: "c".repeat(64), principalRef: "c".repeat(64), personRef: "c".repeat(64), field: "intro", normalizationVersion: "nfc-v2", baselineDigest: "c".repeat(64), issuedAt: "2026-11-03T23:59:00.000Z", expiresAt: "2026-11-04T00:06:00.000Z", mac: "A".repeat(43) })) {
    assert.equal(f.verify({ ...t, [name]: value }, binding).ok, false, name);
  }
  for (const field of ["principalRef", "personRef", "field", "normalizationVersion"] as const) {
    assert.equal(f.verify(t, { ...binding, [field]: field.endsWith("Ref") ? "c".repeat(64) : "other" }).ok, false, field);
  }
  assert.equal(f.verify({ ...t, extra: "draft" }, binding).ok, false);
  for (const value of [null, [], {}, "token", { ...t, issuedAt: "invalid" }, { ...t, mac: "x" }, { ...t, field: ["intro", "displayName"] }]) assert.equal(f.verify(value, binding).ok, false);
  assert.equal(Object.isFrozen(t), true);
  assert.equal(JSON.stringify(t).includes("draft"), false);
  // Valid shape and valid MAC length, but incorrect key must fail authentication.
  assert.equal(api.createBrowserWriteTokens({ activeKeyVersion: "key1", keys: { key1: "different-key-material-at-least-32bytes" } }).verify(t, binding).ok, false);
});

test("BW-functional expiry is inclusive and independent of recoverable authenticity", () => {
  const f = factory(), t = f.issue(binding, baseline(), now);
  assert.equal(api.browserFirstWriteExpired(t, new Date(now.getTime() + 299999)), false);
  assert.equal(api.browserFirstWriteExpired(t, new Date(t.expiresAt)), true);
  assert.equal(api.browserFirstWriteExpired(t, new Date(now.getTime() - 1)), true);
  assert.equal(api.browserFirstWriteExpired(t, new Date(NaN)), true);
  // Verification intentionally has no clock: expired original receipts remain recoverable.
  assert.equal(f.verify(t, binding).ok, true);
  const rotated = api.createBrowserWriteTokens({ activeKeyVersion: "key2", keys: { key1: key, key2: "new-secret-key-material-32bytes-minimum" } });
  assert.equal(rotated.verify(t, binding).ok, true);
  const retired = api.createBrowserWriteTokens({ activeKeyVersion: "key2", keys: { key2: key } });
  assert.deepEqual(retired.verify(t, binding), { ok: false, reason: "recovery_unavailable" });
});

test("BW-functional baseline and payload digests preserve every semantic distinction", () => {
  const digest = api.browserBaselineDigest;
  const nullDigest = baseline();
  assert.notEqual(nullDigest, digest({ persisted: { kind: "present", value: "" }, shownFallback: null }));
  assert.notEqual(nullDigest, digest({ persisted: { kind: "present", value: false }, shownFallback: null }));
  const fallback = { sourceRef: "c".repeat(64), valueDigest: "d".repeat(64), revision: "r1" };
  const initial = digest({ persisted: { kind: "null" }, shownFallback: fallback });
  assert.notEqual(initial, nullDigest);
  for (const field of ["sourceRef", "valueDigest", "revision"] as const) assert.notEqual(initial, digest({ persisted: { kind: "null" }, shownFallback: { ...fallback, [field]: field === "revision" ? "r2" : "e".repeat(64) } }));
  const change = api.browserChangeSetDigest;
  for (const other of [null, "", false, "Name  Here", " Name Here", "Name Here "]) assert.notEqual(change(binding, "Name Here"), change(binding, other));
  assert.notEqual(change(binding, "é"), change(binding, "e\u0301")); // caller owns NFC, not token code
  assert.equal(change(binding, "e\u0301".normalize("NFC")), change(binding, "é"));
  for (const field of ["principalRef", "personRef", "field", "normalizationVersion"] as const) assert.notEqual(change(binding, "Name Here"), change({ ...binding, [field]: field.endsWith("Ref") ? "c".repeat(64) : "other" }, "Name Here"));
  assert.equal(change({ ...binding }, "Name Here"), change(binding, "Name Here"));
  assert.equal(/^[0-9a-f]{64}$/.test(change(binding, "PII-CANARY")), true);
  assert.throws(() => digest({ persisted: { kind: "present", value: undefined }, shownFallback: null } as never));
  assert.throws(() => change(binding, {} as never));
});

test("BW-functional invalid issuance and key configuration fail closed", () => {
  assert.throws(() => api.createBrowserWriteTokens({ activeKeyVersion: "key1", keys: { key1: "short" } }));
  assert.throws(() => api.createBrowserWriteTokens({ activeKeyVersion: "missing", keys: { key1: key } }));
  assert.throws(() => factory().issue({ ...binding, field: "one,two" }, baseline(), now));
  assert.throws(() => factory().issue(binding, "raw-value", now));
  assert.throws(() => factory().issue(binding, baseline(), new Date(NaN)));
  const bytes = Buffer.from(key);
  const f = api.createBrowserWriteTokens({ activeKeyVersion: "key1", keys: { key1: bytes } });
  const token = f.issue(binding, baseline(), now);
  bytes.fill(0);
  assert.equal(f.verify(token, binding).ok, true);
});

// Compile-time API compatibility: no legacy CommitOutcome change and recovery cannot return a new write.
const outcomeTypes: BrowserWriteOutcome[] = ["token_payload_mismatch", "state_changed", "expired", "not_authorized", "unknown", "recovery_unavailable"].map(status => ({ status } as BrowserWriteOutcome));
const recoveryType: BrowserReceiptStatus = { status: "not_found" };
const port: BrowserWriteAPI = { save: () => outcomeTypes[0], receiptStatus: () => recoveryType };
void port;

test("BW source mutants are killed by behavioral assertions", { skip: Boolean(process.env.BROWSER_TOKEN_MUTANT) }, async () => {
  const source = await readFile(sourceURL, "utf8");
  const dir = await mkdtemp(join(tmpdir(), "browser-token-mutants-"));
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const run = (url: string, pattern = "BW-functional") => spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, fileURLToPath(import.meta.url)], { encoding: "utf8", env: { ...childEnv, BROWSER_TOKEN_MUTANT: url } });
  try {
    const path = join(dir, "candidate.mjs");
    const candidates: [string, string, string][] = [
      ["ignore MAC", "!timingSafeEqual(Buffer.from(value.mac), Buffer.from(signature(value, key)))", "false"],
      ["ignore expected binding", "bindingParts(value).some((v, i) => v !== bindingParts(expected)[i])", "false"],
      ["expiry off by one", "now.getTime() >= Date.parse(token.expiresAt)", "now.getTime() > Date.parse(token.expiresAt)"],
      ["ignore extra keys", "JSON.stringify(Object.keys(t).sort()) === JSON.stringify(tokenKeys)", "true"],
      ["ignore fallback revision", "f.sourceRef, f.valueDigest, f.revision", "f.sourceRef, f.valueDigest, null"],
      ["collapse null and empty", 'p.kind, p.kind === "present" ? p.value : null', '"same", p.kind === "present" ? p.value : ""'],
      ["normalize silently", "...bindingParts(binding), canonicalValue", '...bindingParts(binding), typeof canonicalValue === "string" ? canonicalValue.normalize("NFC") : canonicalValue'],
      ["reuse operation identity", 'randomBytes(32).toString("hex")', '"a".repeat(64)'],
      ["omit payload field", 'b.personRef, b.field, b.normalizationVersion', 'b.personRef, "ignored", b.normalizationVersion'],
      ["omit baseline signature", "t.baselineDigest, t.issuedAt", '"ignored", t.issuedAt'],
    ];
    await writeFile(path, source);
    const control = run(pathToFileURL(path).href);
    assert.equal(control.status, 0, `unmodified control: ${control.stdout}\n${control.stderr}`);
    assert.match(control.stdout, /# pass 4/, "control must execute all four functional tests");
    for (const [name, from, to] of candidates) {
      assert.equal(source.split(from).length - 1, 1, `unique mutant anchor: ${name}`);
      await writeFile(path, source.replace(from, to));
      const intended = name === "expiry off by one" ? "expiry is inclusive" :
        ["ignore fallback revision", "collapse null and empty", "normalize silently", "omit payload field"].includes(name) ? "baseline and payload digests" : "render tokens are fresh";
      const result = run(pathToFileURL(path).href, `BW-functional ${intended}`);
      assert.notEqual(result.status, 0, `survived: ${name}`);
      assert.match(result.stdout, new RegExp(`not ok [0-9]+ - BW-functional ${intended}`), `intended test must fail: ${name}`);
      assert.match(result.stdout + result.stderr, /AssertionError|ERR_ASSERTION/, `must fail a behavioral assertion: ${name}`);
      assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/, name);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
