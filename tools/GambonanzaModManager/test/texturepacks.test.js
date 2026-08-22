'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('../src/main/paths');
const png = require('../src/main/png');
const packs = require('../src/main/texturepacks');

// A fake game and a fake catalogue, both on disk. Seeding the catalogue cache
// is what keeps these tests offline: assetcatalog only goes to the network
// when its cache is missing or stale.

const BUILD = 'testbuild';

/** Two sprites on one 16x16 sheet, plus a standalone 8x8 texture. */
const CATALOG = {
  build: BUILD,
  counts: { total: 4, sprites: 2, textures: 2 },
  categories: [{ name: 'Test', count: 4 }],
  entries: [
    {
      id: 'sheet', kind: 'texture', name: 'SHEET', label: 'Sheet',
      width: 16, height: 16, category: 'Test', format: 'RGBA32', compressed: false, spriteCount: 2,
    },
    {
      id: 'left', kind: 'sprite', name: 'LEFT', label: 'Left',
      width: 4, height: 4, category: 'Test', format: 'RGBA32', compressed: false,
      atlas: 'SHEET', atlasId: 'sheet', atlasWidth: 16, atlasHeight: 16,
      // Bottom-left origin: y=0 is the BOTTOM row, so this lands at the bottom.
      rect: [2, 0, 4, 4],
    },
    {
      id: 'right', kind: 'sprite', name: 'RIGHT', label: 'Right',
      width: 4, height: 4, category: 'Test', format: 'RGBA32', compressed: false,
      atlas: 'SHEET', atlasId: 'sheet', atlasWidth: 16, atlasHeight: 16,
      rect: [10, 12, 4, 4],
    },
    {
      id: 'solo', kind: 'texture', name: 'SOLO', label: 'Solo',
      width: 8, height: 8, category: 'Test', format: 'DXT5', compressed: true, spriteCount: 0,
    },
  ],
};

const TEXTS = {
  build: BUILD,
  languages: ['en', 'fr'],
  counts: { texts: 1, languages: 2 },
  sections: [{ name: 'utils', entries: [{ key: 'launch', values: ['LAUNCH', 'LANCER'] }] }],
};

let modsDir;

function solid(width, height, [r, g, b, a]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }
  return { width, height, data };
}

function pixel(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [...image.data.subarray(i, i + 4)];
}

function seedCatalogCache(root) {
  const dir = path.join(root, 'cache', 'assets');
  fs.mkdirSync(path.join(dir, 'img', BUILD), { recursive: true });
  const fetchedAt = Date.now();
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ data: CATALOG, fetchedAt, source: 'test' }));
  fs.writeFileSync(path.join(dir, 'texts.json'), JSON.stringify({ data: TEXTS, fetchedAt, source: 'test' }));

  // A recognisable "vanilla" sheet: grey everywhere.
  fs.writeFileSync(path.join(dir, 'img', BUILD, 'sheet.png'), png.encode(solid(16, 16, [128, 128, 128, 255])));
  fs.writeFileSync(path.join(dir, 'img', BUILD, 'solo.png'), png.encode(solid(8, 8, [1, 2, 3, 255])));
  fs.writeFileSync(path.join(dir, 'img', BUILD, 'left.png'), png.encode(solid(4, 4, [0, 0, 0, 255])));
  fs.writeFileSync(path.join(dir, 'img', BUILD, 'right.png'), png.encode(solid(4, 4, [0, 0, 0, 255])));
}

function readAtlas(packId, targetId) {
  return png.decode(fs.readFileSync(path.join(paths.texturePacksDir(), packId, 'atlases', `${targetId}.png`)));
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmm-tp-root-'));
  paths.setRoot(root);
  seedCatalogCache(root);
  // Drop the module-level memo so a previous test's catalogue cannot leak in.
  delete require.cache[require.resolve('../src/main/assetcatalog')];
  modsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gmm-tp-game-')), 'Mods');
  fs.mkdirSync(modsDir, { recursive: true });
});

// ---------------------------------------------------------------------------

test('a new pack is empty and knows the game build it was made against', async () => {
  const { id } = await packs.create({ name: 'Midnight' });
  const detail = await packs.detail(id);
  assert.equal(detail.name, 'Midnight');
  assert.equal(detail.gameBuild, BUILD);
  assert.deepEqual(detail.images, []);
  assert.deepEqual(detail.texts, []);
});

test('a pack needs a name', async () => {
  await assert.rejects(packs.create({ name: '   ' }), /needs a name/);
});

test('overriding a sprite composites it into its sheet, flipped to top-left origin', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  const art = png.encode(solid(4, 4, [255, 0, 0, 255]));

  await packs.setImage({ id, assetId: 'left', bytes: art });

  const sheet = readAtlas(id, 'sheet');
  assert.equal(sheet.width, 16);
  // rect [2, 0, 4, 4] is bottom-left, so in image coordinates it is the BOTTOM
  // four rows: top = 16 - 0 - 4 = 12.
  assert.deepEqual(pixel(sheet, 2, 12), [255, 0, 0, 255]);
  assert.deepEqual(pixel(sheet, 5, 15), [255, 0, 0, 255]);
  // One pixel outside on every side is still vanilla.
  assert.deepEqual(pixel(sheet, 1, 12), [128, 128, 128, 255]);
  assert.deepEqual(pixel(sheet, 6, 12), [128, 128, 128, 255]);
  assert.deepEqual(pixel(sheet, 2, 11), [128, 128, 128, 255]);
});

test('two sprites on one sheet both land, and the sheet is listed once', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await packs.setImage({ id, assetId: 'left', bytes: png.encode(solid(4, 4, [255, 0, 0, 255])) });
  await packs.setImage({ id, assetId: 'right', bytes: png.encode(solid(4, 4, [0, 0, 255, 255])) });

  const sheet = readAtlas(id, 'sheet');
  assert.deepEqual(pixel(sheet, 2, 12), [255, 0, 0, 255]);
  assert.deepEqual(pixel(sheet, 10, 0), [0, 0, 255, 255]);   // top = 16 - 12 - 4 = 0

  const detail = await packs.detail(id);
  assert.equal(detail.images.length, 2);
  assert.equal(detail.textureCount, 1);
});

test('removing one override rebuilds the sheet from pristine, keeping the other', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await packs.setImage({ id, assetId: 'left', bytes: png.encode(solid(4, 4, [255, 0, 0, 255])) });
  await packs.setImage({ id, assetId: 'right', bytes: png.encode(solid(4, 4, [0, 0, 255, 255])) });

  await packs.removeImage({ id, assetId: 'left' });

  const sheet = readAtlas(id, 'sheet');
  assert.deepEqual(pixel(sheet, 2, 12), [128, 128, 128, 255], 'the removed sprite is back to vanilla');
  assert.deepEqual(pixel(sheet, 10, 0), [0, 0, 255, 255], 'the other override survived');
});

test('removing the last override on a sheet drops the sheet entirely', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await packs.setImage({ id, assetId: 'left', bytes: png.encode(solid(4, 4, [255, 0, 0, 255])) });
  await packs.removeImage({ id, assetId: 'left' });

  const detail = await packs.detail(id);
  assert.equal(detail.images.length, 0);
  assert.equal(detail.textureCount, 0);
  assert.equal(fs.existsSync(path.join(paths.texturePacksDir(), id, 'atlases', 'sheet.png')), false);
});

test('replacing a whole texture becomes the base layer under its sprite edits', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await packs.setImage({ id, assetId: 'sheet', bytes: png.encode(solid(16, 16, [7, 7, 7, 255])) });
  await packs.setImage({ id, assetId: 'left', bytes: png.encode(solid(4, 4, [255, 0, 0, 255])) });

  const sheet = readAtlas(id, 'sheet');
  assert.deepEqual(pixel(sheet, 0, 0), [7, 7, 7, 255], 'the new sheet shows through');
  assert.deepEqual(pixel(sheet, 2, 12), [255, 0, 0, 255], 'the sprite edit sits on top');
});

test('art at the wrong size is scaled with nearest neighbour and reported', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  const result = await packs.setImage({ id, assetId: 'left', bytes: png.encode(solid(2, 2, [9, 9, 9, 255])) });

  assert.equal(result.resized, true);
  assert.deepEqual(result.given, { width: 2, height: 2 });
  const sheet = readAtlas(id, 'sheet');
  assert.deepEqual(pixel(sheet, 2, 12), [9, 9, 9, 255]);
});

test('an unknown asset id is refused', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await assert.rejects(
    packs.setImage({ id, assetId: 'nope', bytes: png.encode(solid(4, 4, [0, 0, 0, 255])) }),
    /not in the asset catalogue/,
  );
});

test('an asset id that tries to escape the cache folder is refused', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await assert.rejects(
    packs.setImage({ id, assetId: '../../etc/passwd', bytes: png.encode(solid(4, 4, [0, 0, 0, 255])) }),
    /not a valid asset id/,
  );
});

// ---------------------------------------------------------------------------

test('text overrides default to every language and refuse to be empty', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await packs.setText({ id, section: 'utils', key: 'launch', value: 'GO!', original: 'LAUNCH' });

  const detail = await packs.detail(id);
  assert.equal(detail.texts.length, 1);
  assert.deepEqual(detail.texts[0].values, [{ lang: '*', value: 'GO!' }]);
  assert.equal(detail.texts[0].original, 'LAUNCH');

  await assert.rejects(packs.setText({ id, section: 'utils', key: 'launch', value: '  ' }), /cannot be empty/);
});

test('a per-language override sits alongside the catch-all', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await packs.setText({ id, section: 'utils', key: 'launch', value: 'GO!' });
  await packs.setText({ id, section: 'utils', key: 'launch', lang: 'fr', value: 'ALLEZ' });

  const detail = await packs.detail(id);
  assert.equal(detail.texts.length, 1);
  assert.deepEqual(detail.texts[0].values.map((v) => v.lang).sort(), ['*', 'fr']);
});

test('dropping the last language of a text override drops the override', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await packs.setText({ id, section: 'utils', key: 'launch', value: 'GO!' });
  const still = await packs.removeText({ id, section: 'utils', key: 'launch', lang: 'fr' });
  assert.equal(still.texts.length, 1, 'removing a language that was never set changes nothing');
  const gone = await packs.removeText({ id, section: 'utils', key: 'launch', lang: '*' });
  assert.equal(gone.texts.length, 0);
});

test('the game\'s colour sentinels are flagged, not mangled', () => {
  assert.equal(packs.markupWarnings('plain text'), null);
  assert.deepEqual(packs.markupWarnings('a _golden_ word'), ['_']);
  assert.deepEqual(packs.markupWarnings('& and *').sort(), ['&', '*']);
});

// ---------------------------------------------------------------------------

test('applying a pack writes only the runtime payload into the game folder', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await packs.setImage({ id, assetId: 'left', bytes: png.encode(solid(4, 4, [255, 0, 0, 255])) });
  await packs.setText({ id, section: 'utils', key: 'launch', value: 'GO!' });

  await packs.setActive({ id, modsDir });

  const dir = packs.gamePackDir(modsDir);
  assert.ok(fs.existsSync(path.join(dir, 'texturepack.json')));
  assert.ok(fs.existsSync(path.join(dir, 'atlases', 'sheet.png')));
  assert.equal(fs.existsSync(path.join(dir, 'images')), false, 'source art stays in the library');

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'texturepack.json'), 'utf8'));
  assert.equal(manifest.textures.length, 1);
  assert.equal(manifest.textures[0].name, 'SHEET');
  assert.equal(manifest.textures[0].width, 16);
  assert.deepEqual(manifest.texts, [{ section: 'utils', key: 'launch', values: [{ lang: '*', value: 'GO!' }] }]);
});

test('turning packs off clears the game folder', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await packs.setImage({ id, assetId: 'left', bytes: png.encode(solid(4, 4, [255, 0, 0, 255])) });
  await packs.setActive({ id, modsDir });
  await packs.setActive({ id: null, modsDir });

  assert.equal(fs.existsSync(packs.gamePackDir(modsDir)), false);
  assert.equal((await packs.summary()).activeId, null);
});

test('deleting the applied pack undresses the game first', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await packs.setImage({ id, assetId: 'left', bytes: png.encode(solid(4, 4, [255, 0, 0, 255])) });
  await packs.setActive({ id, modsDir });

  await packs.remove({ id, modsDir });

  assert.equal(fs.existsSync(packs.gamePackDir(modsDir)), false);
  assert.deepEqual((await packs.summary()).packs, []);
});

test('summary reports a selection that no longer exists as nothing selected', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await packs.setActive({ id, modsDir: null });
  fs.rmSync(path.join(paths.texturePacksDir(), id), { recursive: true, force: true });
  assert.equal((await packs.summary()).activeId, null);
});

// ---------------------------------------------------------------------------

test('export then import reproduces the pack', async () => {
  const { id } = await packs.create({ name: 'Shareable' });
  await packs.setImage({ id, assetId: 'left', bytes: png.encode(solid(4, 4, [255, 0, 0, 255])) });
  await packs.setImage({ id, assetId: 'solo', bytes: png.encode(solid(8, 8, [4, 5, 6, 255])) });
  await packs.setText({ id, section: 'utils', key: 'launch', value: 'GO!' });

  const dest = path.join(os.tmpdir(), `gmm-tp-${Date.now()}.zip`);
  await packs.exportPack({ id, destPath: dest });
  assert.ok(fs.statSync(dest).size > 0);

  const imported = await packs.importPack({ zipPath: dest });
  assert.notEqual(imported.id, id, 'an import is a new pack, never an overwrite');
  assert.equal(imported.name, 'Shareable');
  assert.equal(imported.images, 2);
  assert.equal(imported.texts, 1);

  const sheet = readAtlas(imported.id, 'sheet');
  assert.deepEqual(pixel(sheet, 2, 12), [255, 0, 0, 255], 'sheets are recomposited on import');
  const solo = readAtlas(imported.id, 'solo');
  assert.deepEqual(pixel(solo, 0, 0), [4, 5, 6, 255]);

  fs.rmSync(dest, { force: true });
});

test('an empty pack cannot be exported', async () => {
  const { id } = await packs.create({ name: 'Empty' });
  await assert.rejects(
    packs.exportPack({ id, destPath: path.join(os.tmpdir(), 'never.zip') }),
    /empty/,
  );
});

test('importing a zip that is not a pack says so', async () => {
  const AdmZip = require('adm-zip');
  const archive = new AdmZip();
  archive.addFile('readme.txt', Buffer.from('hello'));
  const dest = path.join(os.tmpdir(), `gmm-notapack-${Date.now()}.zip`);
  fs.writeFileSync(dest, archive.toBuffer());

  await assert.rejects(packs.importPack({ zipPath: dest }), /does not contain a texture pack/);
  fs.rmSync(dest, { force: true });
});

test('an import drops overrides this game build no longer has', async () => {
  const AdmZip = require('adm-zip');
  const archive = new AdmZip();
  archive.addFile('texturepack.json', Buffer.from(JSON.stringify({
    formatVersion: 1,
    name: 'Half stale',
    images: [{ assetId: 'left' }, { assetId: 'renamed-by-a-game-update' }],
    texts: [],
  })));
  archive.addFile('images/left.png', png.encode(solid(4, 4, [255, 0, 0, 255])));
  const dest = path.join(os.tmpdir(), `gmm-stale-${Date.now()}.zip`);
  fs.writeFileSync(dest, archive.toBuffer());

  const imported = await packs.importPack({ zipPath: dest });
  assert.equal(imported.images, 1);
  assert.equal(imported.skipped, 1);

  fs.rmSync(dest, { force: true });
});

test('rename and describe round trip', async () => {
  const { id } = await packs.create({ name: 'Before' });
  await packs.rename({ id, name: 'After' });
  await packs.describe({ id, author: 'ben', summary: 'a summary', version: '2.1.0' });

  const detail = await packs.detail(id);
  assert.equal(detail.name, 'After');
  assert.equal(detail.author, 'ben');
  assert.equal(detail.summary, 'a summary');
  assert.equal(detail.version, '2.1.0');
});

test('pack ids are validated before they name a directory', () => {
  assert.equal(packs.safePackId('tp-deadbeef'), 'tp-deadbeef');
  assert.throws(() => packs.safePackId('../escape'), /not a valid pack id/);
  assert.throws(() => packs.safePackId('Has Capitals'), /not a valid pack id/);
});

// ---------------------------------------------------------------------------
// Guards. Each of these exists because the thing it checks was once wrong.

test('installFromRegistry is actually exported', () => {
  // It was defined and never exported once, which made the whole "install a
  // community pack" button a no-op that only showed up at runtime.
  assert.equal(typeof packs.installFromRegistry, 'function');
});

test('a registry pack with no recorded checksum is refused, not installed', async () => {
  await assert.rejects(
    packs.installFromRegistry({
      entry: {
        id: 'x', name: 'X', repo: 'someone/packs',
        latest: { asset: { url: 'https://github.com/someone/packs/releases/download/v1/x.zip', sha256: '' } },
      },
    }),
    /no verified checksum/,
  );
});

test('a registry pack with no release at all is refused', async () => {
  await assert.rejects(packs.installFromRegistry({ entry: { id: 'x', name: 'X' } }), /no release to download/);
});

test('summary reports which registry entry a pack came from', async () => {
  const { id } = await packs.create({ name: 'From the registry' });
  const manifest = JSON.parse(fs.readFileSync(path.join(paths.texturePacksDir(), id, 'texturepack.json'), 'utf8'));
  manifest.registryId = 'noir-board';
  fs.writeFileSync(path.join(paths.texturePacksDir(), id, 'texturepack.json'), JSON.stringify(manifest));

  const listed = (await packs.summary()).packs.find((p) => p.id === id);
  assert.equal(listed.registryId, 'noir-board');
});

test('a sheet id that tries to escape the pack folder is refused', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await packs.setImage({ id, assetId: 'left', bytes: png.encode(solid(4, 4, [1, 2, 3, 255])) });

  // Doctor the manifest the way a hostile catalogue or a hand-edited pack could.
  const file = path.join(paths.texturePacksDir(), id, 'texturepack.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.images[0].atlasId = '../../escape';
  await assert.rejects(packs.recomposeAll(manifest), /not a valid asset id/);
});

test('an edit that cannot be composited leaves the pack exactly as it was', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await packs.setImage({ id, assetId: 'left', bytes: png.encode(solid(4, 4, [255, 0, 0, 255])) });

  // Evict the pristine sheet the way a game update does, with no network to
  // re-fetch it: the next compose on that sheet must fail.
  const cached = path.join(paths.texturePacksDir(), '..', 'cache', 'assets', 'img', BUILD, 'sheet.png');
  const keep = fs.readFileSync(cached);
  fs.rmSync(cached);

  await assert.rejects(packs.setImage({ id, assetId: 'right', bytes: png.encode(solid(4, 4, [0, 255, 0, 255])) }));

  // The rejected art is nowhere: not in images/, not in the sheet, not listed.
  const detail = await packs.detail(id);
  assert.equal(detail.images.length, 1, 'the failed edit was not recorded');
  assert.equal(fs.existsSync(path.join(paths.texturePacksDir(), id, 'images', 'right.png')), false);
  assert.deepEqual(pixel(readAtlas(id, 'sheet'), 10, 0), [128, 128, 128, 255], 'the sheet is untouched');

  fs.writeFileSync(cached, keep);
});

test('a failed removal leaves the override in place rather than orphaning it', async () => {
  const { id } = await packs.create({ name: 'Pack' });
  await packs.setImage({ id, assetId: 'left', bytes: png.encode(solid(4, 4, [255, 0, 0, 255])) });
  await packs.setImage({ id, assetId: 'right', bytes: png.encode(solid(4, 4, [0, 0, 255, 255])) });

  const cached = path.join(paths.texturePacksDir(), '..', 'cache', 'assets', 'img', BUILD, 'sheet.png');
  const keep = fs.readFileSync(cached);
  fs.rmSync(cached);

  await assert.rejects(packs.removeImage({ id, assetId: 'left' }));

  // Its artwork is still there, so retrying once the sheet is back works.
  assert.ok(fs.existsSync(path.join(paths.texturePacksDir(), id, 'images', 'left.png')));
  fs.writeFileSync(cached, keep);
  const after = await packs.removeImage({ id, assetId: 'left' });
  assert.equal(after.images.length, 1);
});
