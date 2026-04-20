// Generates placeholder PWA icons. Solid-color tiles with a centered "D"
// glyph. Real artwork lands with the design-polish pass; until then these
// satisfy the manifest-icon + maskable criteria for Lighthouse PWA.
//
// Uses only Node built-ins (no `sharp`) so CI doesn't need native modules.
//
//   pnpm --filter @diktat/web exec node scripts/generate-icons.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

// Brand indigo (close to --color-accent-primary from @diktat/ui tokens).
const BG = { r: 0x4c, g: 0x3a, b: 0xf7 };
const FG = { r: 0xff, g: 0xff, b: 0xff };

// Minimal 5x7 bitmap for a capital "D" so we don't ship a font.
const GLYPH_D = [
  '11110',
  '10001',
  '10001',
  '10001',
  '10001',
  '10001',
  '11110',
];

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = (table[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng({ size, bg, fg, maskable }) {
  // Maskable icons need ~10% safe-area padding so the platform mask can crop.
  const safePad = maskable ? Math.floor(size * 0.1) : 0;
  const canvas = size;
  const glyphW = GLYPH_D[0].length;
  const glyphH = GLYPH_D.length;
  const inner = canvas - safePad * 2;
  const scale = Math.floor((inner * 0.55) / glyphH);
  const glyphPxW = glyphW * scale;
  const glyphPxH = glyphH * scale;
  const gx = Math.floor((canvas - glyphPxW) / 2);
  const gy = Math.floor((canvas - glyphPxH) / 2);

  const raw = Buffer.alloc(canvas * (1 + canvas * 3));
  for (let y = 0; y < canvas; y++) {
    const rowStart = y * (1 + canvas * 3);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < canvas; x++) {
      let inGlyph = false;
      if (x >= gx && x < gx + glyphPxW && y >= gy && y < gy + glyphPxH) {
        const gxi = Math.floor((x - gx) / scale);
        const gyi = Math.floor((y - gy) / scale);
        inGlyph = GLYPH_D[gyi][gxi] === '1';
      }
      const c = inGlyph ? fg : bg;
      const off = rowStart + 1 + x * 3;
      raw[off] = c.r;
      raw[off + 1] = c.g;
      raw[off + 2] = c.b;
    }
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(canvas, 0);
  ihdr.writeUInt32BE(canvas, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const specs = [
  { name: 'icon-192.png', size: 192, maskable: false },
  { name: 'icon-512.png', size: 512, maskable: false },
  { name: 'maskable-512.png', size: 512, maskable: true },
];

for (const spec of specs) {
  const png = makePng({ size: spec.size, bg: BG, fg: FG, maskable: spec.maskable });
  const path = resolve(outDir, spec.name);
  writeFileSync(path, png);
  console.log(`wrote ${path} (${png.length} bytes)`);
}
