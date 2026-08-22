# Gambonanza Mod Manager

The desktop app for playing with mods: patches Gambonanza (with a backup),
installs mods from the [registry](../../registry/), and keeps the framework,
the mods and itself up to date. Electron, plain JavaScript, no build step for
the UI, no framework - the whole renderer is one HTML file, one CSS file and
one JS file you can read top to bottom.

**Players don't build this** - they download it from
[the site](https://bentrd.github.io/GambonanzaMods/). This README is for
working on it.

## Run from source

```bash
cd tools/GambonanzaModManager
npm install
npm start          # or: npm run dev  (opens devtools)
```

## Test / check

```bash
npm test           # unit tests (node:test) - pure logic, no Electron needed
npm run lint       # node --check over every file
```

## Package

```bash
cp ../../registry/index.json assets/registry-index.json
npm run dist       # current platform; dist:mac / dist:win / dist:linux
```

CI does this for all three platforms on `manager-v*` tags - see
[docs/RELEASING.md](../../docs/RELEASING.md).

## Architecture

```
src/
├── main/                the privileged side (Node)
│   ├── index.js         window, IPC surface, update scheduler
│   ├── config.js        every URL/host/id in one place
│   ├── game.js          find the install, inspect its patch state
│   ├── framework.js     download bundle → backup → run patcher → verify
│   ├── mods.js          install/update/remove/toggle mods (staged + atomic swap)
│   ├── modpacks.js      named setups: mods + a texture pack, one active at a time
│   ├── texturepacks.js  the pack library: edit, composite sheets, wear, share
│   ├── assetcatalog.js  the game's sprites/textures/strings, fetched + cached
│   ├── png.js           an exact PNG codec (see below)
│   ├── registry.js      fetch the mod index (Pages → raw → bundled fallback)
│   ├── net.js           allowlisted HTTPS + checksum-verified downloads
│   ├── zip.js           traversal-safe extraction, and pack export
│   ├── publish.js       GitHub device-flow sign-in + registry PR submission
│   ├── store.js         settings (atomic JSON file)
│   ├── log.js           manager.log + the in-app activity feed
│   └── versions.js      version comparison (pure, tested)
├── preload.js           the entire main↔renderer bridge, ~40 lines
└── renderer/            sandboxed UI (no Node access)
```

## Modpacks

A modpack is a whole setup - the mods it loads and the texture pack it wears -
and exactly one is active. The trick that keeps everything else oblivious: the
active modpack's mods simply **are** the game's `Mods/` folder. Inactive ones
park theirs under the manager's own data directory, and switching is a handful
of directory renames.

That is what makes installs need no special casing (writing to `Mods/` writes
to the active modpack), and what makes launching straight from Steam load the
right thing - there is no "the launcher forgot to sync" failure mode.

Publishing one is metadata only: the registry stores the ids of the mods and
the texture pack, never a binary. Installing someone else's modpack builds it
as a new local modpack and switches to it, downloading each part from its own
author's release and checking it against the checksum the registry recorded.

## Texture packs

A texture pack is art and wording, never code. The interesting part is that
the game does not draw sprites from files - it draws them from big shared
sheets, 210 gambit icons on one 512x512 texture. So replacing one icon means
rewriting that sheet.

That happens here, not in the game: `texturepacks.js` takes the pristine sheet
from the catalogue, pastes the new icon into its rectangle, and writes the
whole sheet into the pack. The framework then only ever calls Unity's
`LoadImage` on a texture it found by name - no reading pixels back off the GPU,
no sprite-rect arithmetic, no colour-space guessing at runtime.

Two consequences worth knowing:

- **`png.js` is a real codec, not a wrapper.** A `<canvas>` round trip stores
  colours premultiplied by alpha and loses precision in every semi-transparent
  pixel, and Electron's `nativeImage` does the same. Replacing one icon must
  leave the other 209 on that sheet byte-identical, so the pixels are handled
  by hand. It decodes 8- and 16-bit non-interlaced PNGs and writes 8-bit RGBA.
- **The catalogue is published, not read from the install.** Reading Unity
  `.assets` files needs UnityPy, which needs Python, which is exactly the
  hassle this feature exists to delete. `tools/build-asset-catalog.py` (run by
  a maintainer after a game update) publishes the metadata; preview art comes
  from the companion [GambonanzaAssets](https://github.com/bentrd/GambonanzaAssets)
  site, which already hosts one PNG per asset. Both are fetched through
  `net.js` and served to the renderer as `data:` URLs, so the sandboxed UI
  never touches the network itself.

Security model, in short: the renderer is fully sandboxed and talks through
the typed bridge in `preload.js`; every download goes through `net.js`, which
only speaks HTTPS to GitHub hosts, pins mod downloads to the repo named in
their registry entry, and verifies the SHA-256 recorded at review time before
anything is unpacked; `zip.js` refuses path-traversal entries; the patcher
backs up `Assembly-CSharp.dll` before every change and `Restore` puts the
original back byte for byte.
