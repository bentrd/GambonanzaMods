'use strict';

const zlib = require('node:zlib');

// A small, exact PNG codec.
//
// Replacing one gambit icon means rewriting the 512x512 sheet it lives on, and
// the other 209 icons on that sheet must come back out bit for bit. That rules
// out the obvious shortcuts: a <canvas> round trip stores colours premultiplied
// by alpha and loses precision in every semi-transparent pixel, and Electron's
// nativeImage does the same. So the pixels are handled here, where nothing
// touches a byte it was not asked to.
//
// Scope is deliberately narrow - 8- and 16-bit non-interlaced PNGs, which is
// what every pixel-art editor and the catalogue's own images are. Anything
// stranger raises a readable error and the caller falls back to Electron's
// decoder, where a re-encode of the user's own artwork is acceptable.

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Ceiling on decoded pixel data. The game's biggest sheet is 2048x2048. */
const MAX_PIXEL_BYTES = 96 * 1024 * 1024;
const MAX_DIMENSION = 8192;

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// ---------------------------------------------------------------------------
// CRC-32 (the PNG spec's own table-driven variant)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Width and height without inflating a single pixel. */
function size(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(SIG)) throw new Error('not a PNG file');
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG is missing its header chunk');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(SIG);
}

/** Decode to straight (non-premultiplied) 8-bit RGBA. */
function decode(buffer) {
  if (!isPng(buffer)) throw new Error('not a PNG file');

  let width = 0;
  let height = 0;
  let depth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) throw new Error('PNG is truncated');

    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      depth = buffer[start + 8];
      colorType = buffer[start + 9];
      interlace = buffer[start + 12];
    } else if (type === 'PLTE') {
      palette = buffer.subarray(start, end);
    } else if (type === 'tRNS') {
      transparency = buffer.subarray(start, end);
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4; // skip the chunk's CRC
  }

  if (!width || !height) throw new Error('PNG has no image data');
  // Refuse absurd headers before allocating anything for them.
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`PNG is ${width}x${height}, larger than this app will decode`);
  }
  if (width * height * 4 > MAX_PIXEL_BYTES) throw new Error('PNG is too large to decode');
  if (interlace) throw new Error('interlaced PNGs are not supported - save it without interlacing');
  if (depth !== 8 && depth !== 16) {
    if (!(colorType === 3 && (depth === 1 || depth === 2 || depth === 4))) {
      throw new Error(`${depth}-bit PNGs are not supported - save it as 8-bit`);
    }
  }
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error('indexed PNG has no palette');

  // A 600 KB PNG can declare a 65535x65535 image and inflate to gigabytes.
  // Packs arrive as zips from strangers, so cap what a decode may allocate at
  // a little over the largest sheet the game actually has (1920x1080x4).
  const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: MAX_PIXEL_BYTES });
  const bitsPerPixel = channels * depth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const bytesPerRow = Math.ceil((width * bitsPerPixel) / 8);
  if (raw.length < (bytesPerRow + 1) * height) throw new Error('PNG pixel data is short');

  const lines = unfilter(raw, width, height, bytesPerRow, bytesPerPixel);
  return { width, height, data: toRgba(lines, { width, height, depth, colorType, channels, palette, transparency, bytesPerRow }) };
}

/** Undo the per-scanline filters PNG applies before compression. */
function unfilter(raw, width, height, bytesPerRow, bpp) {
  const out = Buffer.allocUnsafe(bytesPerRow * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + bytesPerRow);
    pos += bytesPerRow;
    const cur = out.subarray(y * bytesPerRow, (y + 1) * bytesPerRow);
    const prev = y > 0 ? out.subarray((y - 1) * bytesPerRow, y * bytesPerRow) : null;

    for (let x = 0; x < bytesPerRow; x++) {
      const rawByte = line[x];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let value;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + ((a + b) >> 1); break;
        case 4: value = rawByte + paeth(a, b, c); break;
        default: throw new Error(`unknown PNG row filter ${filter}`);
      }
      cur[x] = value & 0xff;
    }
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function toRgba(lines, meta) {
  const { width, height, depth, colorType, channels, palette, transparency, bytesPerRow } = meta;
  const out = Buffer.allocUnsafe(width * height * 4);
  const step = depth === 16 ? 2 : 1;

  for (let y = 0; y < height; y++) {
    const row = y * bytesPerRow;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;

      if (colorType === 3) {
        const index = readIndex(lines, row, x, depth);
        const p = index * 3;
        out[o] = palette[p] ?? 0;
        out[o + 1] = palette[p + 1] ?? 0;
        out[o + 2] = palette[p + 2] ?? 0;
        out[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
        continue;
      }

      // 16-bit samples keep only the high byte: the game's textures are 8-bit,
      // so the low byte has nowhere to go.
      const base = row + x * channels * step;
      if (colorType === 0 || colorType === 4) {
        const grey = lines[base];
        out[o] = grey; out[o + 1] = grey; out[o + 2] = grey;
        out[o + 3] = colorType === 4 ? lines[base + step] : greyAlpha(grey, transparency, depth);
      } else {
        out[o] = lines[base];
        out[o + 1] = lines[base + step];
        out[o + 2] = lines[base + 2 * step];
        out[o + 3] = colorType === 6 ? lines[base + 3 * step] : rgbAlpha(lines, base, step, transparency, depth);
      }
    }
  }
  return out;
}

function readIndex(lines, row, x, depth) {
  if (depth === 8) return lines[row + x];
  const perByte = 8 / depth;
  const byte = lines[row + Math.floor(x / perByte)];
  const shift = 8 - depth * ((x % perByte) + 1);
  return (byte >> shift) & ((1 << depth) - 1);
}

/** tRNS on a greyscale image names one fully transparent grey level. */
function greyAlpha(grey, transparency, depth) {
  if (!transparency || transparency.length < 2) return 255;
  const key = depth === 16 ? transparency[0] : transparency[1];
  return grey === key ? 0 : 255;
}

/** tRNS on a truecolour image names one fully transparent colour. */
function rgbAlpha(lines, base, step, transparency, depth) {
  if (!transparency || transparency.length < 6) return 255;
  const at = (i) => (depth === 16 ? transparency[i * 2] : transparency[i * 2 + 1]);
  const match = lines[base] === at(0) && lines[base + step] === at(1) && lines[base + 2 * step] === at(2);
  return match ? 0 : 255;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function chunk(type, data) {
  const out = Buffer.allocUnsafe(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Encode straight 8-bit RGBA as a PNG. Rows are filtered with the standard
 * minimum-sum-of-absolute-differences heuristic - shared texture packs travel
 * over the internet, and unfiltered 2048x2048 sheets are several times larger.
 *
 * Deflate level 6, not 9, on purpose. Filtered photographic art is close to
 * noise, and level 9's lazy matching spends ten times as long on it for four
 * percent fewer bytes: 2.9s versus 0.3s on the 1920x1080 boss sheets. Nobody
 * wants a three-second freeze after dropping in a PNG.
 */
function encode({ width, height, data }, { level = 6 } = {}) {
  if (!width || !height) throw new Error('cannot encode a zero-sized image');
  if (data.length !== width * height * 4) throw new Error('pixel buffer does not match the given size');

  const bpp = 4;
  const rowBytes = width * bpp;
  const raw = Buffer.allocUnsafe((rowBytes + 1) * height);

  // Five candidate rows, allocated once. Each filter gets its own tight loop
  // rather than a switch inside the hot one: a 2048x2048 sheet is 16 million
  // bytes and this runs five times over every one of them.
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.allocUnsafe(rowBytes));
  const score = new Float64Array(5);
  let prev = Buffer.alloc(rowBytes);

  for (let y = 0; y < height; y++) {
    const line = data.subarray(y * rowBytes, (y + 1) * rowBytes);
    score.fill(0);
    const [c0, c1, c2, c3, c4] = cand;

    for (let x = 0; x < rowBytes; x++) {
      const cur = line[x];
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;

      const v0 = cur;
      const v1 = (cur - a) & 0xff;
      const v2 = (cur - b) & 0xff;
      const v3 = (cur - ((a + b) >> 1)) & 0xff;
      const v4 = (cur - paeth(a, b, c)) & 0xff;

      c0[x] = v0; c1[x] = v1; c2[x] = v2; c3[x] = v3; c4[x] = v4;
      score[0] += v0 < 128 ? v0 : 256 - v0;
      score[1] += v1 < 128 ? v1 : 256 - v1;
      score[2] += v2 < 128 ? v2 : 256 - v2;
      score[3] += v3 < 128 ? v3 : 256 - v3;
      score[4] += v4 < 128 ? v4 : 256 - v4;
    }

    let best = 0;
    for (let f = 1; f < 5; f++) if (score[f] < score[best]) best = f;

    raw[y * (rowBytes + 1)] = best;
    cand[best].copy(raw, y * (rowBytes + 1) + 1);
    prev = line;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

/**
 * Nearest-neighbour scaling. Anything smoother turns a 21-pixel icon to mush,
 * and this only ever runs when someone hands us art at the wrong size.
 */
function resizeNearest(image, width, height) {
  if (image.width === width && image.height === height) return image;
  const out = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      image.data.copy(out, (y * width + x) * 4, (sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4);
    }
  }
  return { width, height, data: out };
}

/**
 * Overwrite a rectangle of `dst` with `src`, alpha included. A replacement
 * REPLACES: blending the new art over the old would leave the old showing
 * through anywhere the new art is transparent.
 *
 * `y` is measured from the top. Callers holding a Unity rect (bottom-left
 * origin) convert with `dst.height - rect.y - rect.height`.
 */
function paste(dst, src, x, y) {
  for (let row = 0; row < src.height; row++) {
    const dy = y + row;
    if (dy < 0 || dy >= dst.height) continue;
    for (let col = 0; col < src.width; col++) {
      const dx = x + col;
      if (dx < 0 || dx >= dst.width) continue;
      src.data.copy(dst.data, (dy * dst.width + dx) * 4, (row * src.width + col) * 4, (row * src.width + col) * 4 + 4);
    }
  }
  return dst;
}

function clone(image) {
  return { width: image.width, height: image.height, data: Buffer.from(image.data) };
}

module.exports = { decode, encode, size, isPng, resizeNearest, paste, clone, crc32 };
