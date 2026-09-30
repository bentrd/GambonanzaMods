'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspect } = require('../src/main/wav');
function wav({ format = 1, bits = 16, channels = 1 } = {}) {
  const size = bits / 8 * channels;
  const b = Buffer.alloc(44 + size);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(format, 20);
  b.writeUInt16LE(channels, 22); b.writeUInt32LE(48000, 24); b.writeUInt32LE(48000 * size, 28);
  b.writeUInt16LE(size, 32); b.writeUInt16LE(bits, 34); b.write('data', 36); b.writeUInt32LE(size, 40);
  return b;
}
test('accepts PCM16 and float32 mono/stereo WAV', () => {
  for (const channels of [1, 2]) for (const [format, bits] of [[1, 16], [3, 32]]) {
    assert.equal(inspect(wav({ format, bits, channels })).duration, 1 / 48000);
  }
});
test('refuses unsupported codecs, corrupt chunks, invalid layout and nonfinite float samples', () => {
  assert.throws(() => inspect(wav({ format: 2 })), /valid WAV/);
  assert.throws(() => inspect(wav({ channels: 3 })), /valid WAV/);
  const truncated = wav(); truncated.writeUInt32LE(10000, 40);
  assert.throws(() => inspect(truncated), /valid WAV/);
  const misaligned = wav(); misaligned.writeUInt16LE(8, 32);
  assert.throws(() => inspect(misaligned), /valid WAV/);
  const invalid = wav({ format: 3, bits: 32 }); invalid.writeFloatLE(NaN, 44);
  assert.throws(() => inspect(invalid), /valid WAV/);
});
