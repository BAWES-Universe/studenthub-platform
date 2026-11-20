import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { formatBits, penalty, QR_MAX_BYTES, qrModules, reedSolomon, versionBits } from "../src/index.js";

const hash = (m: boolean[][]) => createHash("sha256").update(m.map(row => row.map(v => v ? "#" : ".").join("")).join("\n")).digest("hex");

// Golden codes made by the python `qrcode` package (byte mode, level M, the same mask forced),
// each also read back by a QR decoder when they were made.
const GOLDEN: [string, number, number, string][] = [
  ["https://studenthub.co/v/abc", 2, 29, "36794c410f9440a8549ed4a8de0ab50e9cb19134aabeb82c77ea7ec1cfc5c799"],
  ["https://studenthub.co/v/" + "Ab9_-".repeat(16), 5, 41, "9a81755e3f52cf2b267848cbdb774ddb2bbb8651953a6ea2fb792817243e0a9c"],
  ["y".repeat(213), 1, 57, "846a7d6bcfd964a49e0268223c995754d1abc37d172c9cb49536946fcde73133"],
  ["é and ü ✓", 6, 21, "c6db6b594f2e39a71b5e3e7a603b3d7bfd8f3c2a75a1faf8aa37d49eb4f4d674"],
  ["https://studenthub.co/v/" + "Q".repeat(120), 3, 49, "384634b3b970057015f8de43bc5384ded39135c61ceb040d4394314035edfaf2"],
];

test("REPORTS_QR matches a reference encoder module for module, versions 1 to 10", () => {
  for (const [text, mask, size, sha] of GOLDEN) {
    const m = qrModules(text, mask);
    assert.equal(m.length, size, text); assert.ok(m.every(r => r.length === size));
    assert.equal(hash(m), sha, `${text.slice(0, 30)} mask ${mask}`);
  }
});

test("REPORTS_QR format and version information, and Reed-Solomon, follow the standard's worked values", () => {
  assert.equal(formatBits(0), 0x5412, "level M, mask 0");
  assert.equal(formatBits(5), 0x40ce, "level M, mask 5");
  assert.equal(versionBits(7), 0x07c94);
  assert.equal(versionBits(10), 0x0a4d3);
  // ISO/IEC 18004 annex I: "01234567" at 1-M.
  const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
  assert.deepEqual(reedSolomon(data, 10), [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
});

test("REPORTS_QR picks the lowest-penalty mask, keeps the finder patterns, and refuses what cannot fit", () => {
  const text = "https://studenthub.co/v/17.20270219.AAAAAAAAAAAAAAAAAAAAAA", auto = qrModules(text);
  const scores = Array.from({ length: 8 }, (_, m) => penalty(qrModules(text, m)));
  assert.equal(penalty(auto), Math.min(...scores));
  const n = auto.length;
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      assert.equal(auto[r0! + r]![c0! + c], ring !== 2, `finder at ${r0},${c0}`);
    }
  }
  assert.equal(auto[n - 8]![8], true, "the dark module");
  assert.equal(qrModules("x".repeat(QR_MAX_BYTES)).length, 57);
  assert.throws(() => qrModules("x".repeat(QR_MAX_BYTES + 1)), /too long/);
  assert.throws(() => qrModules("x", 8), /mask/);
});
