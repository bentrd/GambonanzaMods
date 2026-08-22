'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const png = require('../src/main/png');

// The whole reason this codec exists is that untouched pixels have to survive
// a decode/encode round trip exactly - replacing one gambit icon rewrites the
// 512x512 sheet the other 209 live on.

function solid(width, height, [r, g, b, a]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }
  return { width, height, data };
}

/** Deterministic pseudo-noise: the hardest case for the row filters. */
function noise(width, height, seed = 1) {
  const data = Buffer.alloc(width * height * 4);
  let x = seed;
  for (let i = 0; i < data.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    data[i] = x >> 16 & 0xff;
  }
  return { width, height, data };
}

test('round trips solid colour exactly', () => {
  const image = solid(8, 5, [12, 200, 34, 255]);
  const back = png.decode(png.encode(image));
  assert.equal(back.width, 8);
  assert.equal(back.height, 5);
  assert.ok(back.data.equals(image.data));
});

test('round trips noise exactly, including alpha', () => {
  const image = noise(37, 23);
  const back = png.decode(png.encode(image));
  assert.ok(back.data.equals(image.data));
});

test('preserves colour under fully transparent pixels', () => {
  // A canvas round trip would zero these; an art tool must not.
  const image = solid(4, 4, [200, 100, 50, 0]);
  const back = png.decode(png.encode(image));
  assert.deepEqual([...back.data.subarray(0, 4)], [200, 100, 50, 0]);
});

test('size() reads dimensions without inflating', () => {
  const buffer = png.encode(solid(64, 32, [0, 0, 0, 255]));
  assert.deepEqual(png.size(buffer), { width: 64, height: 32 });
});

test('rejects things that are not PNGs', () => {
  assert.equal(png.isPng(Buffer.from('not a png')), false);
  assert.throws(() => png.decode(Buffer.from('not a png')), /not a PNG/);
});

test('every row filter decodes correctly', () => {
  // Encode picks filters adaptively, so drive them explicitly instead: build a
  // one-row image per filter type by hand and check it comes back.
  const width = 6;
  const line = Buffer.from([9, 8, 7, 255, 40, 41, 42, 255, 90, 91, 92, 128, 5, 5, 5, 1, 250, 1, 2, 3, 7, 7, 7, 7]);
  for (const filter of [0, 1, 2, 3, 4]) {
    const raw = Buffer.concat([Buffer.from([filter]), applyFilter(filter, line)]);
    const buffer = manualPng(width, 1, raw);
    const back = png.decode(buffer);
    assert.ok(back.data.equals(line), `filter ${filter} did not round trip`);
  }
});

function applyFilter(filter, line) {
  const bpp = 4;
  const out = Buffer.alloc(line.length);
  for (let x = 0; x < line.length; x++) {
    const a = x >= bpp ? line[x - bpp] : 0;
    switch (filter) {
      case 0: out[x] = line[x]; break;
      case 1: out[x] = (line[x] - a) & 0xff; break;
      case 2: out[x] = line[x]; break;              // no row above: b == 0
      case 3: out[x] = (line[x] - (a >> 1)) & 0xff; break;
      default: out[x] = (line[x] - a) & 0xff; break; // paeth with b=c=0 picks a
    }
  }
  return out;
}

function manualPng(width, height, raw) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(png.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

test('resizeNearest keeps hard pixel edges', () => {
  const image = { width: 2, height: 2, data: Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 0, 255,
  ]) };
  const big = png.resizeNearest(image, 4, 4);
  assert.equal(big.width, 4);
  // Top-left quadrant is pure red - no blending with its neighbours.
  assert.deepEqual([...big.data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...big.data.subarray(4, 8)], [255, 0, 0, 255]);
  assert.deepEqual([...big.data.subarray(8, 12)], [0, 255, 0, 255]);
});

test('resizeNearest returns the same object when nothing changes', () => {
  const image = solid(3, 3, [1, 2, 3, 4]);
  assert.equal(png.resizeNearest(image, 3, 3), image);
});

test('paste replaces a rectangle and leaves everything else byte-identical', () => {
  const sheet = solid(10, 10, [10, 20, 30, 255]);
  const before = Buffer.from(sheet.data);
  const patch = solid(3, 2, [200, 0, 0, 128]);

  png.paste(sheet, patch, 4, 6);

  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const i = (y * 10 + x) * 4;
      const inside = x >= 4 && x < 7 && y >= 6 && y < 8;
      const actual = [...sheet.data.subarray(i, i + 4)];
      if (inside) assert.deepEqual(actual, [200, 0, 0, 128], `pixel ${x},${y}`);
      else assert.deepEqual(actual, [...before.subarray(i, i + 4)], `pixel ${x},${y} should be untouched`);
    }
  }
});

test('paste overwrites rather than blending - transparent art clears the sheet', () => {
  const sheet = solid(4, 4, [255, 255, 255, 255]);
  png.paste(sheet, solid(2, 2, [0, 0, 0, 0]), 0, 0);
  assert.deepEqual([...sheet.data.subarray(0, 4)], [0, 0, 0, 0]);
});

test('paste clips at the edges instead of wrapping or throwing', () => {
  const sheet = solid(4, 4, [0, 0, 0, 255]);
  png.paste(sheet, solid(3, 3, [9, 9, 9, 255]), 3, 3);
  assert.deepEqual([...sheet.data.subarray((3 * 4 + 3) * 4, (3 * 4 + 3) * 4 + 4)], [9, 9, 9, 255]);
  // The row above the pasted corner is still background.
  assert.deepEqual([...sheet.data.subarray((2 * 4 + 3) * 4, (2 * 4 + 3) * 4 + 4)], [0, 0, 0, 255]);
});

test('clone does not share its buffer', () => {
  const image = solid(2, 2, [1, 1, 1, 1]);
  const copy = png.clone(image);
  copy.data[0] = 99;
  assert.equal(image.data[0], 1);
});
