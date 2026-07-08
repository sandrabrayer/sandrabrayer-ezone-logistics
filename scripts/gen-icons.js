/**
 * Self-contained PWA icon (re)generator — no external dependencies.
 *
 * Uses only Node's built-in `zlib` to decode and re-encode 8-bit RGBA PNGs.
 * It re-colours the EXISTING original logo-glyph PNGs in place, preserving the
 * exact glyph shape and anti-aliasing, so a colour pass never redraws the mark.
 *
 * The source PNGs (src/public/icon-v1-*.png) are the ORIGINAL E-Zone brand
 * glyph as first shipped in the ecosystem — dark background, green logo —
 * recovered byte-for-byte from ezone-outpatient git history (commit e1b0da0,
 * the state before its recolour PRs). We do NOT redraw the mark; we only
 * remap its two ink colours.
 *
 * Colour pass. OLD_* are the colours baked into those original PNGs, so the
 * remap reads the source pixels correctly:
 *   background  #071410  ->  #071410 (dark, unchanged)
 *   logo        #29d488  ->  #00bfa5 (Logistics teal)
 *
 * Every source pixel is treated as a blend  t*logo + (1-t)*background.
 * We recover t from the pixel's RGB, then emit  t*newLogo + (1-t)*newBg.
 * That keeps every soft edge smooth instead of hard-thresholding the glyph.
 *
 * The maskable icon is flattened to a fully-opaque DARK square (alpha forced
 * to 255) so the safe-zone padding stays dark to the very edge and the launcher
 * mask never reveals a transparent — cropped-looking — corner.
 *
 * Run:  node scripts/gen-icons.js
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '..', 'src', 'public');

// Old (source) colours baked into the ORIGINAL icon-v1-*.png.
const OLD_BG = [7, 20, 16];        // #071410
const OLD_LOGO = [41, 212, 136];   // #29d488
// New colours.
const NEW_BG = [7, 20, 16];        // #071410 (dark, unchanged)
const NEW_LOGO = [0, 191, 165];    // #00bfa5 (Logistics teal)

// ---- CRC32 (PNG chunk checksums) -----------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- PNG decode (8-bit RGBA only) ----------------------------------------
function decodeRGBA(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG: ' + file);
  let off = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bd !== 8 || ct !== 6) throw new Error('expected 8-bit RGBA, got bd=' + bd + ' ct=' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const v = raw[pos++];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? out[(y - 1) * stride + x - bpp] : 0;
      let recon;
      if (ft === 0) recon = v;
      else if (ft === 1) recon = v + a;
      else if (ft === 2) recon = v + b;
      else if (ft === 3) recon = v + ((a + b) >> 1);
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        recon = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error('bad filter type ' + ft);
      out[y * stride + x] = recon & 0xff;
    }
  }
  return { w, h, data: out };
}

// ---- PNG encode (8-bit RGBA, filter 0 / None per scanline) ---------------
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodeRGBA(w, h, data) {
  const bpp = 4, stride = w * bpp;
  const rawWithFilters = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    rawWithFilters[y * (stride + 1)] = 0; // filter: None
    data.copy(rawWithFilters, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = zlib.deflateSync(rawWithFilters, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- colour remap --------------------------------------------------------
const DBG = [OLD_LOGO[0] - OLD_BG[0], OLD_LOGO[1] - OLD_BG[1], OLD_LOGO[2] - OLD_BG[2]];
const DBG_LEN2 = DBG[0] * DBG[0] + DBG[1] * DBG[1] + DBG[2] * DBG[2];

function remap(img, { flattenAlpha }) {
  const { w, h, data } = img;
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    // blend fraction toward the logo colour
    let t = ((r - OLD_BG[0]) * DBG[0] + (g - OLD_BG[1]) * DBG[1] + (b - OLD_BG[2]) * DBG[2]) / DBG_LEN2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    out[i] = Math.round(NEW_BG[0] + t * (NEW_LOGO[0] - NEW_BG[0]));
    out[i + 1] = Math.round(NEW_BG[1] + t * (NEW_LOGO[1] - NEW_BG[1]));
    out[i + 2] = Math.round(NEW_BG[2] + t * (NEW_LOGO[2] - NEW_BG[2]));
    out[i + 3] = flattenAlpha ? 255 : a;
  }
  return { w, h, data: out };
}

// ---- run -----------------------------------------------------------------
const JOBS = [
  { file: 'icon-v1-192.png', flattenAlpha: false },
  { file: 'icon-v1-512.png', flattenAlpha: false },
  // Maskable: flatten to an opaque DARK square so the safe-zone padding is dark
  // to the edge and never looks cropped under a launcher mask.
  { file: 'icon-v1-maskable.png', flattenAlpha: true },
];

for (const job of JOBS) {
  const src = path.join(PUB, job.file);
  const img = decodeRGBA(src);
  const recolored = remap(img, job);
  const png = encodeRGBA(recolored.w, recolored.h, recolored.data);
  fs.writeFileSync(src, png);
  console.log('wrote', job.file, `${recolored.w}x${recolored.h}`, png.length, 'bytes',
    job.flattenAlpha ? '(opaque dark)' : '');
}
console.log('done');
