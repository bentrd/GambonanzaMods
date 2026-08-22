# Texture packs

A texture pack is art and wording layered over Gambonanza: replacement images
for any sprite or sheet, and replacement text for any of the game's 1229
strings, in any of its 11 languages. It contains no code, and it changes
nothing in your game install.

Players never read this file - they open the mod manager's **Texture packs**
tab and click things. This is for anyone working on the feature, hand-editing
a pack, or wondering why it was built this way.

---

## The one hard problem

The game does not draw sprites from files. It draws them from **sheets**: one
512x512 texture holds all 210 gambit icons, another holds every white chess
piece. A sprite is a named rectangle carved out of a sheet.

So "replace the Warlock icon" really means "rewrite a 512x512 texture, changing
21x27 pixels of it and leaving the other 261,577 exactly as they were."

Everything below follows from where that rewrite happens.

## Where the rewrite happens: in the manager, not the game

The mod manager composites. It holds the pristine sheet, pastes the
replacement into the sprite's rectangle, and stores the finished sheet in the
pack. At runtime the framework does one thing per sheet:

```csharp
texture.LoadImage(png, markNonReadable: true);
```

The alternative - compositing in-game - means reading the sheet's pixels back
off the GPU, which on a non-readable compressed texture means a `Graphics.Blit`
into a render texture, a `ReadPixels`, a colour-space judgement call, and a
sprite-rect calculation that has to cope with fractional rectangles, trimmed
sprites and packing rotation. Every one of those is a way to be subtly wrong on
someone else's machine, and none of them can be tested from here.

Doing it in the manager makes the runtime a single call that either works or
logs why it didn't.

### Rectangles, precisely

`registry/assets/catalog.json` carries each sprite's rectangle as integers,
snapped outwards from Unity's float rect:

```
x0 = floor(rect.x)                y0 = floor(rect.y)
x1 = min(atlasW, ceil(rect.x + rect.width))
y1 = min(atlasH, ceil(rect.y + rect.height))
```

The outward snap is not defensive rounding - it is required. Sprites the
packer trimmed have genuinely fractional rects (`SPR_Chain` sits at
`381.076, 425.076, 223.848 x 223.848`), and truncating loses a column and puts
the replacement a pixel out. Snapping outwards also matches the size of the PNG
the catalogue publishes for that sprite, so "the image you download" and "the
rectangle it goes back into" are the same number of pixels.

Unity rectangles start at the **bottom** left; images start at the top. The
manager flips once, when it pastes:

```js
png.paste(sheet, art, x, sheet.height - y - h);
```

## What a pack looks like on disk

```
MyPack/
├── texturepack.json     the manifest
├── images/<assetId>.png the artwork you supplied, at the asset's own size
└── atlases/<sheetId>.png the composited sheets - derived, regenerated on every edit
```

`images/` is the source of truth and stays human-readable, so someone who opens
the zip finds their own art rather than a 2048x2048 sheet. `atlases/` is what
the game actually loads.

Sheets are **always** rebuilt from the pristine original plus every override
that lands on them. That is what makes removing an override actually remove it,
and what stops two edits to the same sheet from stacking.

### The manifest

```json
{
  "formatVersion": 1,
  "id": "tp-1a2b3c4d",
  "name": "Midnight Chess",
  "author": "you",
  "version": "1.0.0",
  "gameBuild": "24858528",

  "images": [ { "assetId": "spr-gambits-warlock", "kind": "sprite", "...": "editor metadata" } ],

  "textures": [
    { "targetId": "spr-gambits", "name": "SPR_Gambits",
      "width": 512, "height": 512, "file": "atlases/spr-gambits.png" }
  ],

  "texts": [
    { "section": "utils", "key": "launch",
      "values": [ { "lang": "*", "value": "BEGIN THE RITUAL" } ] }
  ]
}
```

The framework reads only `textures` and `texts`. `name` in a `textures` entry
is the Unity object name of the texture to replace - that, and the PNG, is the
whole contract.

`lang` is a game language code (`en`, `fr`, `ge`, `sp`, `pt_br`, `ru`, `pl`,
`tr`, `jp`, `ko`, `zh`) or `*` for every language. A specific language wins
over `*`.

## How the framework applies it

`src/ModHost/TexturePacks.cs`, loaded from `ModHost.LoadAll` **after** the
mods, so a mod that ships its own art always wins over a re-skin.

**Images.** Sweep every loaded `Texture2D`, match on name, and `LoadImage`.
Sheets stream in as scenes need them, so the sweep repeats - every second for
the first 90, then every five, plus immediately on scene load. Sampler state
(`filterMode`, wrap modes, aniso, mip bias) is captured and put back, because
`LoadImage` resets it and a pixel-art game that loses `filterMode.Point` looks
like a bug report. Dimensions are checked before and after: every sprite on the
sheet addresses it in normalised UVs, so a resized sheet shifts all of them.

**Text.** `LocalizationManager.GetTraduction()` returns a live SimpleJSON tree
that the game re-indexes on every draw, so writing into it changes what gets
displayed next. The catch is that the tree is a *cache*: it is thrown away and
re-parsed whenever the language changes, and again on scene load (nothing in
the game is `DontDestroyOnLoad`). One of those paths - the Steam-language
auto-detect on first launch - fires no event at all.

So the pack is the source of truth and the tree is written repeatedly. A
rebuild is detected by the **identity** of the returned root, not by looking
for a missing key: an overridden vanilla key comes back after a reparse
non-empty and wrong, which a presence check would happily accept.

Values are written through the parent's indexer (`section[key] = value`), never
through `.Value` on the child - a missing key hands back a `JSONLazyCreator`
whose `Value` setter does nothing at all.

**Diagnostics.** Open the console (F10):

- `texturepack` - what is on, how much of it applied, and any problems
- `texturepack list` - every override and whether it landed
- `texturepack reapply` - put it all back on without restarting

Everything also lands in `Player.log` behind `[TexturePacks]`.

## Things worth knowing

**Compressed sheets.** Roughly a quarter of the game's textures are DXT1/DXT5.
Replacing anything on one re-encodes the whole sheet, so colours elsewhere on
it can shift very slightly. The manager says so on the asset's card. RGBA32
sheets - most of the pixel art - are exact.

**Silhouettes.** Sprites carry a tight mesh baked from their original alpha.
For sprites the game draws with a `SpriteRenderer`, pixels outside the original
silhouette are not rasterised, so a replacement can recolour freely but cannot
change a shape's outline. UI images are drawn as quads and are unaffected.

**Trimmed sprites.** The packer strips transparent margins, so the rectangle
you are painting into is the trimmed one. You cannot paint into margin the
packer removed.

**Fonts.** The SDF font atlases are excluded from the catalogue. Painting on
one garbles every letter in the game.

**Game updates.** A pack records the Steam build it was made against. If an
update renames or resizes a texture, the framework skips that override and says
so in the console rather than misaligning a sheet. Regenerate the catalogue
with `python3 tools/build-asset-catalog.py` and re-export affected packs.

## Regenerating the catalogue

```bash
python3 -m pip install UnityPy
python3 tools/build-asset-catalog.py --check-live
```

Writes `registry/assets/catalog.json` and `registry/assets/texts.json`, which
GitHub Pages publishes for the manager to fetch. `--check-live` diffs the ids
against the deployed [GambonanzaAssets](https://github.com/bentrd/GambonanzaAssets)
site, which hosts the preview PNGs - the two agree because this script
reproduces that site's id rule exactly, and the check is there to make a drift
loud instead of leaving every preview quietly 404ing.

## Sharing a pack

**As a file.** Export from the manager. The zip holds the manifest, your
artwork and the composited sheets, so whoever receives it needs no network.

**Through the registry.** Attach that zip to a release in your own GitHub
repository and submit `registry/texturepacks/<id>.json` (the manager's *Share a
pack* form does the typing). CI resolves the newest matching release, records
its SHA-256, and the manager downloads straight from your repo - pinned to it,
and refused if the bytes no longer match what was reviewed. Schema:
[`registry/texturepack-schema.json`](../registry/texturepack-schema.json).

An import is never trusted: the manifest is rebuilt field by field against the
catalogue and every sheet is recomposited locally, so a doctored `atlases/`
entry cannot smuggle in pixels the pack's own artwork doesn't account for.

## What this replaced

`tools/GambonanzaAssets/` was the previous answer: a Python tool that rewrote
`resources.assets` in place, with a backup folder and a restore path. It
worked, and it had four problems that were not fixable from inside it -
it needed Python and UnityPy, it needed the game closed, a Steam update
replaced the patched files and took your art with them, and sharing meant
zipping a folder and explaining where to put it.

It is kept in the tree for reference. Nothing points players at it any more.
