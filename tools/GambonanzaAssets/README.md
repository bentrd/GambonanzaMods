> **Superseded.** Re-skinning now lives in the mod manager's **Texture packs**
> tab: the same gallery, no Python, no rewriting of your game's asset files,
> and packs you can share as a zip or publish to the registry. See
> [docs/TEXTURE_PACKS.md](../../docs/TEXTURE_PACKS.md).
>
> This tool still works and is kept for reference. Use it only if you want the
> old offline behaviour - it patches `resources.assets` in place, needs the game
> closed, and a Steam update wipes its work.

# GambonanzaAssets

Re-skin Gambonanza without writing any code.

GambonanzaAssets opens a browser window with every image in the game - all 561 sprites and
236 textures - in a searchable, categorised gallery. Click a piece of art, download
the PNG, paint over it, drag it back in, press **Apply to game**. Done.

Nothing here touches game logic. It swaps pictures, and only pictures.

---

## Run it

**macOS** - double-click `GambonanzaAssets.command`
**Windows** - double-click `GambonanzaAssets.bat`
**Anything with a terminal** - `./gambonanza-assets.sh`

The first run installs two Python packages (UnityPy and Pillow, ~20 seconds), reads
your game's asset files, and renders every preview. After that it starts in a second.

Your browser opens at `http://127.0.0.1:8770`. Leave the terminal window open while
you work; closing it shuts the tool down.

You need **Python 3.8 or newer** and an installed copy of Gambonanza. If the game
lives somewhere unusual:

```bash
./gambonanza-assets.sh --game "/path/to/steamapps/common/Gambonanza"
```

---

## Make a mod

1. **Find the art.** Type in the search box - `queen`, `warlock`, `boss`, `golden
   tile`. Or click a category on the left. *Gambit icons* alone has all 200.
2. **Download it.** Click the card, then **1 · Download PNG**. You get the exact
   image at its exact size, transparency and all.
3. **Draw.** Any editor works - Aseprite, Photoshop, GIMP, Piskel, Paint.NET. Keep
   the same pixel size if you can; if you don't, GambonanzaAssets scales your image to fit
   (turn that off with the *Auto-fit* checkbox in the sidebar).
4. **Drop it back.** Drag the PNG onto the card it came from, or use the drop zone
   in the side panel. The card gets an **EDITED** badge.
5. **Apply.** Close the game if it's running, then hit **Apply to game**.

Launch Gambonanza and your art is in it.

---

## Undo

- **One image** - select it and click *Undo this change*, then Apply again.
- **Everything** - click **Restore original**. GambonanzaAssets copies the untouched files
  back, byte for byte. Your edits stay staged in `pack/`, so you can re-apply them
  whenever you like.

The pristine files live in
`…/Gambonanza.app/Contents/Resources/Data/_GambonanzaAssets_vanilla_backup/`. As long as
that folder is there, the game can always go back to stock. Steam's *Verify
integrity of game files* also works as a last resort.

---

## Sprites vs textures

Most of the game's art is packed into **atlases** - one big image holding hundreds
of small ones. `SPR_Gambits` is a 512×512 sheet with all 200 gambit icons on it.

- A **sprite** is one rectangle cut out of an atlas: the Warlock icon, the white
  queen. Edit these. GambonanzaAssets pastes your image into the right spot on the sheet
  and leaves everything else alone.
- A **texture** is the whole sheet. Editing one replaces every sprite on it at
  once. Useful if you're redrawing a full set; overkill for a single icon.

Both are in the gallery. Sprites say `27×25`; textures say `512×512 · atlas`. Use
the sidebar checkboxes to show only one kind.

---

## Things worth knowing

**Close the game before applying.** Unity holds its asset files open while running.
GambonanzaAssets refuses to patch a live game rather than corrupt it.

**A Steam update wipes your mods.** Updates replace the asset files with fresh
copies. Just run GambonanzaAssets and hit Apply again - your `pack/` folder survives.
GambonanzaAssets notices when the game changed underneath it and re-takes the backup so it
never restores you to an older version's art.

**Compressed atlases lose a little quality.** Anything marked *DXT1* or *DXT5* is
block-compressed. Re-saving it re-compresses it, so colours can shift very slightly
on parts of the sheet you didn't touch. Uncompressed formats (*RGBA32*) are exact.
Most of the pixel art in this game is RGBA32.

**Fonts are a trap.** The *Fonts & text* category holds SDF atlases. Painting on one
garbles every letter in the game. It's greyed out for a reason.

**Sharing a skin.** Zip your `pack/` folder. Anyone else drops it into their own
GambonanzaAssets folder and presses Apply.

---

## Command line

```bash
./gambonanza-assets.sh                       # normal use
./gambonanza-assets.sh --restore             # put the vanilla art back, no browser
./gambonanza-assets.sh --reindex             # rebuild the index after a game update
./gambonanza-assets.sh --port 9000           # if 8770 is taken
./gambonanza-assets.sh --no-browser          # don't auto-open a tab
```

`pack/` holds your staged PNGs and is safe to copy, share, or delete.
`.cache/` is just previews - delete it any time, it rebuilds.

---

## Why not a mod DLL?

You could write a `Gambonanza.ModSdk` mod that swaps sprites at runtime - see
[`sample_mods/`](../../sample_mods/) - and that survives Steam updates. But it means
C#, a build step, and a patched `Assembly-CSharp.dll`.

GambonanzaAssets is the other trade: no code, no framework, no patching of game logic. If
all you want is a different-looking queen, this is the shorter road.
