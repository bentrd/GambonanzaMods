'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paths = require('../src/main/paths');
const catalog = require('../src/main/assetcatalog');
const BUILD = 'audio-preview-test';
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmm-original-audio-'));
  paths.setRoot(root);
  const cache = path.join(paths.cacheDir(), 'assets');
  fs.mkdirSync(path.join(cache, 'audio', BUILD), { recursive: true });
  fs.writeFileSync(path.join(cache, 'audio.json'), JSON.stringify({ fetchedAt: Date.now(),
    data: { build: BUILD, entries: [{ id: 'audio-tone', name: 'TONE', label: 'Tone' }] } }));
  fs.writeFileSync(path.join(cache, 'audio', BUILD, 'audio-tone.mp3'), Buffer.from('ID3cached preview'));
});
test('original audio is served from the build-specific cache without network access', async () => {
  const url = await catalog.audioDataUrl('audio-tone');
  assert.equal(url, `data:audio/mpeg;base64,${Buffer.from('ID3cached preview').toString('base64')}`);
});
test('original audio refuses traversal and unknown catalogue entries', async () => {
  await assert.rejects(catalog.audioDataUrl('../secret'), /valid asset id/);
  await assert.rejects(catalog.audioDataUrl('audio-missing'), /not in the audio catalogue/);
});
