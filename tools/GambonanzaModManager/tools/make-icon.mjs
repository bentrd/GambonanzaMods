#!/usr/bin/env node
// Draws the app icon: a pixel knight on the wine/cream palette, matching the
// in-game art direction. Pure Node - writes a PNG with zlib, no image libs.
// Run once per icon change:  node tools/make-icon.mjs
// CI converts build/icon.png into .icns/.ico during packaging.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'build');
// The GitHub Pages favicon is the same artwork - write it here so the two
// can't drift apart.
const SITE_FAVICON = path.join(HERE, '..', '..', '..', 'site', 'favicon.png');

// 16x16 sprite, scaled up with hard pixels. Palette indices:
// . transparent  # ink outline  C cream piece  B wine ear  D wine-deep shade
const SPRITE = [
  '.....#..........',
  '....#C####......',
  '....#CCCCC##....',
  '...#CCCCCCCC#...',
  '..#CCCCCCCC##...',
  '..#CC#CCCCCCC#..',
  '.#CCCCCCCCCC#...',
  '.#CCCC#CCCCC#...',
  '.#CBC##CCCCCC#..',
  '..#C#.#CCCC##...',
  '...#.#CCCCC#....',
  '....#CCCCCC#....',
  '...#CCCCCCCC#...',
  '...##########...',
  '..#DDDDDDDDDD#..',
  '..############..',
];

const COLORS = {
  '#': [26, 14, 18, 255],     // ink
  C: [244, 229, 194, 255],    // cream
  B: [126, 46, 62, 255],      // wine (ear)
  D: [90, 34, 48, 255],       // wine-dark
  '.': [0, 0, 0, 0],
};

const SIZE = 512;
const GRID = SPRITE.length;
const SCALE = Math.floor((SIZE * 0.72) / GRID);
const SPRITE_PX = GRID * SCALE;
const OFFSET = Math.floor((SIZE - SPRITE_PX) / 2);
const RADIUS = Math.floor(SIZE * 0.18);
const BORDER = Math.floor(SIZE * 0.028);

const BG = [126, 46, 62, 255];       // wine
const BG_EDGE = [58, 21, 33, 255];   // wine-deep
const INK = [26, 14, 18, 255];

const px = new Uint8Array(SIZE * SIZE * 4);

function put(x, y, [r, g, b, a]) {
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

function insideRounded(x, y) {
  const r = RADIUS;
  const cx = x < r ? r : x >= SIZE - r ? SIZE - r - 1 : x;
  const cy = y < r ? r : y >= SIZE - r ? SIZE - r - 1 : y;
  if (cx === x && cy === y) return true;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!insideRounded(x, y)) { put(x, y, [0, 0, 0, 0]); continue; }
    // ink border ring
    const nearEdge = !insideRounded(x - BORDER, y) || !insideRounded(x + BORDER, y)
      || !insideRounded(x, y - BORDER) || !insideRounded(x, y + BORDER)
      || !insideRounded(x - BORDER, y - BORDER) || !insideRounded(x + BORDER, y + BORDER);
    if (nearEdge) { put(x, y, INK); continue; }
    // vertical wine gradient, subtle
    const t = y / SIZE;
    put(x, y, [
      Math.round(BG[0] + (BG_EDGE[0] - BG[0]) * t * 0.8),
      Math.round(BG[1] + (BG_EDGE[1] - BG[1]) * t * 0.8),
      Math.round(BG[2] + (BG_EDGE[2] - BG[2]) * t * 0.8),
      255,
    ]);
  }
}

// stamp the sprite
for (let gy = 0; gy < GRID; gy++) {
  for (let gx = 0; gx < GRID; gx++) {
    const c = COLORS[SPRITE[gy][gx]];
    if (!c || c[3] === 0) continue;
    for (let sy = 0; sy < SCALE; sy++) {
      for (let sx = 0; sx < SCALE; sx++) {
        put(OFFSET + gx * SCALE + sx, OFFSET + gy * SCALE + sy, c);
      }
    }
  }
}

// ---- encode PNG ----
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  px.subarray(y * SIZE * 4, (y + 1) * SIZE * 4).forEach((v, i) => {
    raw[y * (SIZE * 4 + 1) + 1 + i] = v;
  });
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(OUT_DIR, { recursive: true });
for (const out of [path.join(OUT_DIR, 'icon.png'), SITE_FAVICON]) {
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes, ${SIZE}x${SIZE})`);
}
