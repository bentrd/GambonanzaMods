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
│   ├── registry.js      fetch the mod index (Pages → raw → bundled fallback)
│   ├── net.js           allowlisted HTTPS + checksum-verified downloads
│   ├── zip.js           traversal-safe extraction
│   ├── publish.js       GitHub device-flow sign-in + registry PR submission
│   ├── store.js         settings (atomic JSON file)
│   ├── log.js           manager.log + the in-app activity feed
│   └── versions.js      version comparison (pure, tested)
├── preload.js           the entire main↔renderer bridge, ~40 lines
└── renderer/            sandboxed UI (no Node access)
```

Security model, in short: the renderer is fully sandboxed and talks through
the typed bridge in `preload.js`; every download goes through `net.js`, which
only speaks HTTPS to GitHub hosts, pins mod downloads to the repo named in
their registry entry, and verifies the SHA-256 recorded at review time before
anything is unpacked; `zip.js` refuses path-traversal entries; the patcher
backs up `Assembly-CSharp.dll` before every change and `Restore` puts the
original back byte for byte.
