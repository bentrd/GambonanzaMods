'use strict';

// Keep the supported formats identical to ResourcePackAudio.ReadWave.
const MAX_BYTES = 128 * 1024 * 1024;
function inspect(bytes) {
  const b = Buffer.from(bytes);
  const fail = () => { throw new Error('Use a valid WAV: PCM 16-bit or IEEE float 32-bit, mono or stereo, up to 128 MB.'); };
  if (b.length < 44 || b.length > MAX_BYTES || b.toString('ascii', 0, 4) !== 'RIFF'
    || b.toString('ascii', 8, 12) !== 'WAVE' || b.readUInt32LE(4) + 8 !== b.length) fail();
  let fmt, data;
  for (let pos = 12; pos + 8 <= b.length;) {
    const size = b.readUInt32LE(pos + 4), end = pos + 8 + size;
    if (end > b.length) fail();
    const tag = b.toString('ascii', pos, pos + 4);
    if (tag === 'fmt ') {
      if (fmt || size < 16) fail();
      fmt = { format: b.readUInt16LE(pos + 8), channels: b.readUInt16LE(pos + 10),
        sampleRate: b.readUInt32LE(pos + 12), byteRate: b.readUInt32LE(pos + 16),
        blockAlign: b.readUInt16LE(pos + 20), bits: b.readUInt16LE(pos + 22) };
    }
    if (tag === 'data') { if (data) fail(); data = b.subarray(pos + 8, end); }
    pos = end + (size & 1);
    if (pos > b.length) fail();
  }
  if (!fmt || !data || !data.length || ![1, 2].includes(fmt.channels)
    || fmt.sampleRate < 8000 || fmt.sampleRate > 192000
    || !((fmt.format === 1 && fmt.bits === 16) || (fmt.format === 3 && fmt.bits === 32))
    || fmt.blockAlign !== fmt.channels * fmt.bits / 8
    || fmt.byteRate !== fmt.sampleRate * fmt.blockAlign || data.length % fmt.blockAlign) fail();
  if (fmt.format === 3) {
    for (let i = 0; i < data.length; i += 4) {
      const sample = data.readFloatLE(i);
      if (!Number.isFinite(sample) || Math.abs(sample) > 1) fail();
    }
  }
  return { channels: fmt.channels, sampleRate: fmt.sampleRate,
    duration: data.length / fmt.byteRate, bits: fmt.bits };
}
module.exports = { inspect, MAX_BYTES };
