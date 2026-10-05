import { inflateSync } from 'node:zlib';

const reject = (): never => { throw new Error('invalid'); };
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Bounded PNG decoding: CRCs, mandatory chunks, zlib stream and exact scanline shape.
 * The admitted subset is non-interlaced 8-bit grayscale/RGB/gray-alpha/RGBA. */
function png(bytes: Buffer): void {
  if (!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) reject();
  let offset = 8, width = 0, height = 0, channels = 0, ended = false, idatEnded = false;
  const data: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
    if (end > bytes.length) reject();
    const type = bytes.subarray(offset+4,offset+8).toString('ascii');
    const payload = bytes.subarray(offset+8,end-4);
    if (crc32(bytes.subarray(offset+4,end-4)) !== bytes.readUInt32BE(end-4)) reject();
    if (!width && type !== 'IHDR') reject();
    if (type === 'IHDR') {
      if (width || size !== 13) reject();
      width = payload.readUInt32BE(0); height = payload.readUInt32BE(4);
      channels = ({0:1,2:3,4:2,6:4} as Record<number,number>)[payload[9]!] ?? 0;
      if (!width || !height || width * height > 16000000 || payload[8] !== 8 || !channels || payload[10] || payload[11] || payload[12]) reject();
    } else if (type === 'IDAT') {
      if (idatEnded) reject(); data.push(payload);
    } else if (type === 'IEND') {
      if (size || !data.length || end !== bytes.length) reject(); ended = true; break;
    } else {
      if (data.length) idatEnded = true;
      // No unknown critical chunks, animation or text/embedded metadata in this subset.
      if (type !== 'sRGB' && type !== 'gAMA' && type !== 'pHYs') reject();
    }
    offset = end;
  }
  if (!ended) reject();
  const stride = width * channels + 1, expected = stride * height;
  const compressed = Buffer.concat(data);
  const decoded = inflateSync(compressed, { maxOutputLength: expected, info: true }) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
  if (decoded.buffer.length !== expected || decoded.engine.bytesWritten !== compressed.length) reject();
  for (let row = 0; row < height; row++) if (decoded.buffer[row * stride]! > 4) reject();
}
/** Check JPEG marker framing, dimensions and scan completeness. This is admission,
 * not a malware scan or proof of every entropy-coded pixel. */
function jpeg(bytes: Buffer): void {
  if (bytes[0] !== 255 || bytes[1] !== 216) reject();
  let p = 2, frame = false, scan = false;
  while (p < bytes.length) {
    if (bytes[p++] !== 255) reject();
    while (bytes[p] === 255) p++;
    const marker = bytes[p++];
    if (marker === 217) { if (!frame || !scan || p !== bytes.length) reject(); return; }
    if (marker === undefined || marker === 0 || marker === 216 || (marker >= 208 && marker <= 215) || p+2 > bytes.length) reject();
    const length = bytes.readUInt16BE(p);
    if (length < 2 || p+length > bytes.length) reject();
    if (marker === 192 || marker === 194) {
      if (frame || length < 11 || bytes[p+2] !== 8) reject();
      const height = bytes.readUInt16BE(p+3), width = bytes.readUInt16BE(p+5), components = bytes[p+7]!;
      if (!width || !height || width*height > 16000000 || ![1,3].includes(components) || length !== 8+components*3) reject();
      frame = true;
    }
    p += length;
    if (marker === 218) {
      if (!frame || length < 6) reject(); scan = true;
      const start = p;
      while (p < bytes.length && (bytes[p] !== 255 || bytes[p+1] === 0 || (bytes[p+1]! >= 208 && bytes[p+1]! <= 215))) {
        p += bytes[p] === 255 ? 2 : 1;
      }
      if (p === start) reject();
    }
  }
  reject();
}
/** Conservative classic-xref PDF admission. Reject incremental/encrypted/active
 * documents and broken xref pointers; advanced PDFs require a future scanner. */
function pdf(bytes: Buffer): void {
  const s = bytes.toString('latin1');
  if (!/^%PDF-1\.[0-7][\r\n]/.test(s) || /\/(?:JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile|Encrypt|XFA)\b/.test(s)) reject();
  const tail = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(s);
  if (!tail || (s.match(/%%EOF/g) ?? []).length !== 1 || !/\/Type\s*\/Catalog\b/.test(s) || !/\/Type\s*\/Page\b/.test(s)) reject();
  const offset = Number(tail![1]);
  if (!Number.isSafeInteger(offset) || s.slice(offset,offset+5) !== 'xref\n') reject();
  const section = /^xref\n0 (\d+)\n([\s\S]*?)trailer\s*<<([\s\S]*?)>>\s*startxref/.exec(s.slice(offset));
  if (!section || !/\/Root\s+\d+\s+0\s+R/.test(section![3]!)) reject();
  const rows = section![2]!.trimEnd().split(/\r?\n/);
  if (rows.length !== Number(section![1]) || rows[0] !== '0000000000 65535 f ') {
    // trimEnd strips the trailing space only when there is one row (invalid PDF anyway).
    reject();
  }
  for (let i = 1; i < rows.length; i++) {
    const row = /^(\d{10}) 00000 n\s?$/.exec(rows[i]!);
    if (!row || !s.slice(Number(row[1])).startsWith(`${i} 0 obj`)) reject();
  }
  if ((s.match(/\bendobj\b/g) ?? []).length !== rows.length-1) reject();
}
export function validateCandidateContent(type: string, mime: string, bytes: Buffer): void {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 10*1024*1024) reject();
  try {
    if (type === 'resume' && mime === 'application/pdf') pdf(bytes);
    else if (type !== 'resume' && mime === 'image/png') png(bytes);
    else if (type !== 'resume' && mime === 'image/jpeg') jpeg(bytes);
    else reject();
  } catch { reject(); }
}
