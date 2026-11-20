/**
 * A QR code encoder (ISO/IEC 18004) for the ID card's verification link: byte mode, error
 * correction level M (about 15% of the code can be damaged and still read), versions 1 to 10
 * (up to 213 bytes), and the mask with the lowest penalty, as the standard picks it. No
 * dependencies. `qrModules` returns the modules, true for dark, row 0 at the top, without the
 * quiet zone (a caller leaves four modules of white around it).
 */

// Level M per version: [error correction codewords per block, [blocks, data codewords per block]...].
const LEVEL_M: readonly (readonly [number, readonly (readonly [number, number])[]])[] = [
  [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]],
  [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]],
];
const ALIGNMENT: readonly (readonly number[])[] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const REMAINDER_BITS = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0];
export const QR_MAX_BYTES = 213;

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Array<number>(512), LOG = new Array<number>(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!; }
const mul = (a: number, b: number) => a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;

/** Reed-Solomon error correction codewords for `data`. */
export function reedSolomon(data: readonly number[], count: number): number[] {
  let generator = [1];
  for (let i = 0; i < count; i++) {
    const next = new Array<number>(generator.length + 1).fill(0);
    generator.forEach((g, j) => { next[j] ^= g; next[j + 1] ^= mul(g, EXP[i]!); });
    generator = next;
  }
  const remainder = new Array<number>(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!; remainder.push(0);
    for (let j = 0; j < count; j++) remainder[j] ^= mul(generator[j + 1]!, factor);
  }
  return remainder;
}

/** BCH remainder of `value` (already shifted) by `poly`, for the format and version information. */
function bch(value: number, poly: number): number {
  const top = 31 - Math.clz32(poly);
  for (let v = value; ; ) { const bits = 32 - Math.clz32(v); if (bits <= top) return v; v ^= poly << (bits - top - 1); if (v === 0) return 0; value = v; }
}
export const formatBits = (mask: number) => { const data = (0b00 << 3) | mask; return ((data << 10) | bch(data << 10, 0x537)) ^ 0x5412; };
export const versionBits = (version: number) => (version << 12) | bch(version << 12, 0x1f25);

/** The final codeword sequence (data and error correction, interleaved) for `bytes` at `version`. */
export function codewords(bytes: Buffer, version: number): number[] {
  const [ecPerBlock, groups] = LEVEL_M[version - 1]!;
  const blocks = groups.flatMap(([n, size]) => Array.from({ length: n }, () => size)), capacity = blocks.reduce((a, b) => a + b, 0);
  const bits: number[] = [], push = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4); push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0; data.length < capacity; pad++) data.push(pad % 2 ? 0x11 : 0xec);
  const split: number[][] = []; let at = 0;
  for (const size of blocks) { split.push(data.slice(at, at + size)); at += size; }
  const ec = split.map(block => reedSolomon(block, ecPerBlock)), out: number[] = [];
  for (let i = 0; i < Math.max(...blocks); i++) for (const block of split) if (i < block.length) out.push(block[i]!);
  for (let i = 0; i < ecPerBlock; i++) for (const block of ec) out.push(block[i]!);
  return out;
}

type Grid = { dark: boolean[][]; fixed: boolean[][] };
function base(version: number): Grid {
  const n = version * 4 + 17, dark = Array.from({ length: n }, () => new Array<boolean>(n).fill(false)), fixed = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const set = (r: number, c: number, v: boolean) => { dark[r]![c] = v; fixed[r]![c] = true; };
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]] as const)
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c; if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      set(rr, cc, r >= 0 && r <= 6 && c >= 0 && c <= 6 && ring !== 2);
    }
  // Alignment patterns go everywhere on the grid of centres except the three finder corners;
  // the ones on row or column 6 cross the timing patterns, which leave them as they are.
  const centres = ALIGNMENT[version - 1]!, last = centres.length - 1;
  centres.forEach((r, i) => centres.forEach((c, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }));
  for (let i = 8; i < n - 8; i++) { if (!fixed[6]![i]) set(6, i, i % 2 === 0); if (!fixed[i]![6]) set(i, 6, i % 2 === 0); }
  // Format areas (filled per mask) and the dark module.
  for (let i = 0; i < 9; i++) { if (!fixed[8]![i]) set(8, i, false); if (!fixed[i]![8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { set(8, n - 1 - i, false); set(n - 1 - i, 8, false); }
  set(n - 8, 8, true);
  if (version >= 7) {
    const v = versionBits(version);
    for (let i = 0; i < 18; i++) { const bit = ((v >>> i) & 1) === 1, a = Math.floor(i / 3), b = n - 11 + (i % 3); set(a, b, bit); set(b, a, bit); }
  }
  return { dark, fixed };
}

const MASKS: readonly ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0, r => r % 2 === 0, (_, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function place(grid: Grid, data: readonly number[], remainder: number): void {
  const n = grid.dark.length, bits = data.flatMap(b => Array.from({ length: 8 }, (_, i) => ((b >>> (7 - i)) & 1) === 1)).concat(new Array<boolean>(remainder).fill(false));
  let i = 0, upward = true;
  for (let right = n - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < n; k++) {
      const r = upward ? n - 1 - k : k;
      for (const c of [right, right - 1]) if (!grid.fixed[r]![c]) grid.dark[r]![c] = bits[i++] ?? false;
    }
    upward = !upward;
  }
}

function applyFormat(dark: boolean[][], mask: number): void {
  const n = dark.length, f = formatBits(mask), bit = (i: number) => ((f >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) dark[i]![8] = bit(i);
  dark[7]![8] = bit(6); dark[8]![8] = bit(7); dark[8]![7] = bit(8);
  for (let i = 9; i < 15; i++) dark[8]![14 - i] = bit(i);
  for (let i = 0; i < 8; i++) dark[8]![n - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) dark[n - 15 + i]![8] = bit(i);
}

/** The standard's penalty score for a masked code; the lowest is used. */
export function penalty(dark: readonly (readonly boolean[])[]): number {
  const n = dark.length; let score = 0;
  const line = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j <= n; j++) {
        if (j < n && get(i, j) === get(i, j - 1)) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      // 1:1:3:1:1 finder-like pattern with four light modules on either side.
      for (let j = 0; j + 11 <= n; j++) {
        const s = Array.from({ length: 11 }, (_, k) => get(i, j + k));
        const core = s[4] && !s[5] && s[6] && s[7] && s[8] && !s[9] && s[10], coreLeft = s[0] && !s[1] && s[2] && s[3] && s[4] && !s[5] && s[6];
        if ((core && !s[0] && !s[1] && !s[2] && !s[3]) || (coreLeft && !s[7] && !s[8] && !s[9] && !s[10])) score += 40;
      }
    }
  };
  line((i, j) => dark[i]![j]!); line((i, j) => dark[j]![i]!);
  for (let r = 0; r + 1 < n; r++) for (let c = 0; c + 1 < n; c++) {
    const v = dark[r]![c]; if (v === dark[r]![c + 1] && v === dark[r + 1]![c] && v === dark[r + 1]![c + 1]) score += 3;
  }
  const darkCount = dark.reduce((a, row) => a + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs(darkCount * 20 - n * n * 10) / (n * n)) * 10;
  return score;
}

/** The QR code for `text` (UTF-8) at level M, smallest version that fits; `mask` forces a mask (for tests). */
export function qrModules(text: string, mask?: number): boolean[][] {
  if (mask !== undefined && !(Number.isInteger(mask) && mask >= 0 && mask < 8)) throw new RangeError("mask is 0 to 7");
  const bytes = Buffer.from(text, "utf8");
  const version = LEVEL_M.findIndex(([, groups], i) => groups.reduce((a, [count, size]) => a + count * size, 0) * 8 >= 4 + (i + 1 < 10 ? 8 : 16) + bytes.length * 8) + 1;
  if (version === 0) throw new RangeError("text too long for a QR code");
  const grid = base(version);
  place(grid, codewords(bytes, version), REMAINDER_BITS[version - 1]!);
  let best: boolean[][] | undefined, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    if (mask !== undefined && m !== mask) continue;
    const dark = grid.dark.map((row, r) => row.map((v, c) => grid.fixed[r]![c] ? v : v !== MASKS[m]!(r, c)));
    applyFormat(dark, m);
    const score = mask === undefined ? penalty(dark) : 0;
    if (score < bestScore) { best = dark; bestScore = score; }
  }
  return best!;
}
