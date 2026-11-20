import assert from "node:assert/strict";
import test from "node:test";
import { ID_CARD_PHOTO_SECONDS, ID_CARD_VERIFY_PATH, IdCardVerifier } from "../src/index.js";

const KEY = Buffer.alloc(32, 7), verifier = new IdCardVerifier(KEY);

test("REPORTS_ID_CARD_VERIFY a link carries the card number and printed date, and reads back only with the same key", () => {
  const token = verifier.token(17, "2027-02-19");
  assert.match(token, /^17\.20270219\.[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(verifier.read(token), { cardNumber: 17, validUntil: "2027-02-19" });
  assert.equal(new IdCardVerifier(Buffer.alloc(32, 8)).read(token), undefined, "another key");
  assert.equal(verifier.url("https://studenthub.co/anything", 17, "2027-02-19"), `https://studenthub.co${ID_CARD_VERIFY_PATH}${token}`);
  assert.equal(verifier.url("http://localhost:3000", 1, "2027-01-01").startsWith("http://localhost:3000/v/1.20270101."), true);
  assert.throws(() => verifier.url("http://studenthub.co", 17, "2027-02-19"), /https/);
});

test("REPORTS_ID_CARD_VERIFY a changed number, date or signature, or a malformed link, reads as nothing", () => {
  const token = verifier.token(17, "2027-02-19"), sig = token.split(".")[2]!;
  const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  for (const bad of [`18.20270219.${sig}`, `17.20270520.${sig}`, `17.20270219.${flipped}`, `017.20270219.${sig}`, `17.2027021.${sig}`, `17.20270219.${sig}x`,
    `17.20270219`, "", `9999999999999999999.20270219.${sig}`, ` ${token}`, `${token}\n`])
    assert.equal(verifier.read(bad), undefined, bad);
});

test("REPORTS_ID_CARD_VERIFY the key is at least 32 bytes and kept as a copy", () => {
  assert.throws(() => new IdCardVerifier(Buffer.alloc(31)), /32 bytes/);
  assert.throws(() => new IdCardVerifier("x".repeat(40) as unknown as Buffer), /32 bytes/);
  const key = Buffer.alloc(32, 1), v = new IdCardVerifier(key), token = v.token(5, "2027-01-01");
  key.fill(2);
  assert.deepEqual(v.read(token), { cardNumber: 5, validUntil: "2027-01-01" });
  for (const [n, d] of [[0, "2027-01-01"], [1.5, "2027-01-01"], [Number.MAX_SAFE_INTEGER + 1, "2027-01-01"], [1, "20270101"]] as const)
    assert.throws(() => v.token(n, d), /invalid card/);
});

test("REPORTS_ID_CARD_VERIFY a photo key is made for one link and lasts ID_CARD_PHOTO_SECONDS", () => {
  const token = verifier.token(17, "2027-02-19"), other = verifier.token(18, "2027-02-19"), now = 1_800_000_000;
  const key = verifier.photoKey(token, now);
  assert.match(key, /^1800000060\.[A-Za-z0-9_-]{22}$/);
  assert.equal(verifier.photoKeyValid(token, key, now), true);
  assert.equal(verifier.photoKeyValid(token, key, now + ID_CARD_PHOTO_SECONDS - 1), true);
  assert.equal(verifier.photoKeyValid(token, key, now + ID_CARD_PHOTO_SECONDS), false, "expired");
  assert.equal(verifier.photoKeyValid(other, key, now), false, "another card's link");
  assert.equal(new IdCardVerifier(Buffer.alloc(32, 8)).photoKeyValid(token, key, now), false, "another key");
  const far = verifier.photoKey(token, now + 3600);
  assert.equal(verifier.photoKeyValid(token, far, now), false, "a key that lasts longer than a minute from now is not one this server handed out now");
  for (const bad of ["", "x", `${key}x`, key.replace(/\.[^.]+$/, ".AAAAAAAAAAAAAAAAAAAAAA"), `99999999999.${key.split(".")[1]}`]) assert.equal(verifier.photoKeyValid(token, bad, now), false, bad);
  assert.deepEqual(verifier.parse("7.20270219.AAAAAAAAAAAAAAAAAAAAAA"), { cardNumber: 7, validUntil: "2027-02-19", signed: false });
  assert.equal(verifier.parse("not a token"), undefined);
});
