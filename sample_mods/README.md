# Gambonanza Sample Mods

Reference mods that show the full range of what the Gambonanza modding
framework lets you do, from a one-file tweak to a full library that other mods
can build on.

```
sample_mods/
├── GambitApi/                Library mod - builder for adding new gambits.
├── KamikazeGambit/           Custom gambit built on GambitApi.
├── SpikesGambit/             Custom gambit by TGM: trap tiles capture enemies.
├── EnemyThreatOverlay/       Keybind-driven enemy threat display overlay.
├── MightyKasparovEveryStage/ Debug/sample boss-stage modifier.
├── BetterCollection/         Pure performance mod - smooths the collection screen.
├── build.sh          Builds every mod and stages it into the repo's Mods/ folder.
└── README.md         You are here.
```

If you just want to play with the mods, run `./build.sh --install` and they
will be dropped into the live game's `Gambonanza/Mods/` directory.

If you want to write your own mod, read on.

---

## What is a Gambonanza mod?

A mod is a **.NET DLL** plus a **`mod.json`** file. The DLL contains a class
implementing `Gambonanza.ModSdk.IMod`; `mod.json` tells the loader which class
that is. Both files live together in `Gambonanza/Mods/<YourMod>/`.

When the game starts, `Gambonanza.ModHost` (installed in `Managed/` by the
patcher) walks every subfolder of `Mods/`, parses `mod.json`, calls
`Assembly.LoadFrom()` on the DLL, instantiates the entry class, and calls
`OnLoad`. From that moment your mod is a normal .NET object running inside
Unity - you can spawn `MonoBehaviour`s, hook into game classes via reflection,
swap `SpriteRenderer` materials, anything Unity allows.

There is no Harmony. The framework deliberately stays small: the patcher only
adds three call sites to `Assembly-CSharp.dll` and the rest is plain C#
reflection. If you need to patch a method, do it the hard way (replace the
field, watch a value in `LateUpdate`, instantiate a `MonoBehaviour` that wraps
the target). The samples here show several variations of this pattern.

---

## The mod manifest (`mod.json`)

```json
{
    "id":          "MyMod",
    "name":        "My Mod",
    "version":     "1.0.0",
    "author":      "your name",
    "entry":       "MyNamespace.MyModEntry",
    "enabled":     true,
    "gameVersion": ">=1.0",
    "description": "What your mod does, one line."
}
```

| Field         | Meaning                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------ |
| `id`          | Unique identifier. Used by the in-game console and as the dictionary key in ModRegistry.     |
| `entry`       | Fully qualified class name that implements `IMod`. The loader scans every DLL in your mod folder for this type. |
| `enabled`     | If `false`, the mod is skipped at startup. Toggleable from the in-game console.             |
| `gameVersion` | Currently informational. Use `>=1.0`.                                                       |

---

## The IMod entry point

```csharp
using Gambonanza.ModSdk;

public sealed class MyModEntry : IMod
{
    public void OnLoad(IModContext ctx)
    {
        ctx.LogLine("MyMod is alive.");
    }
}
```

`IModContext` exposes:

- `ModId` / `ModDirectory` - useful for finding bundled assets next to the DLL.
- `LogLine(string)` - writes to `[ModHost] [<ModId>] <message>` in the Unity log.
- `Console` - shared in-game console for commands and messages.
- `OnSettingsOpened` - event fired with the `SettingsCanvas` MonoBehaviour every
  time the player opens the in-game settings panel. Subscribe here to inject
  custom rows (the `Gambonanza.GameUI.Pixel` helpers in
  [docs/UI_API.md](../docs/UI_API.md) clone real game widgets for this).

That is the entire public API. Everything else is your code reaching into the
game via reflection.

---

## The samples

### EnemyThreatOverlay - start here

[`EnemyThreatOverlay/src/EnemyThreatOverlayMod.cs`](EnemyThreatOverlay/src/EnemyThreatOverlayMod.cs)

Holds a key to highlight every square the enemy threatens. The entry class is
~50 lines and demonstrates:

- The `IMod` / `IModLifecycle` boilerplate.
- Declaring a rebindable keybind in `mod.json`.
- Spawning a hidden runner `GameObject` for per-frame work.
- Reading game state via reflection.

(SpeedMod used to be the intro sample; Gambonanza 1.4.0 grew its own
game-speed setting, so it retired.)

### GambitApi - a library other mods build on

[`GambitApi/`](GambitApi/) - multi-file project.

Reverse-engineers the game's gambit registry to expose a fluent
`GambitBuilder` other mods can use to add new gambits:

```csharp
// Keep IDs short/readable: console commands use them, e.g. `give gambit coolio`.
GambitBuilder.Create("coolio")
    .WithName("Coolio's Gambit")
    .WithDescription("Does cool things.")
    .WithRarity(Rarity.EPIC)
    .WithBaseGambit<MyGambitBehaviour>()
    .Register();
```

It also adds runtime patches to the in-game gambit collection screen so it
can paginate past 50 gambits, and a per-mod hook for picking up "extra"
gambits at runtime. Demonstrates the harder patterns:

- Reflecting on private `SerializeField` members of vanilla MonoBehaviours.
- Cloning a vanilla prefab to inherit its visuals, then swapping its scripts.
- Extending vanilla UI without touching `Assembly-CSharp.dll` (we do it from
  a `MonoBehaviour` attached at runtime; see `CollectionPaginationPatch.cs`).

GambitApi is itself a mod - it has its own `mod.json` and is loaded by
ModHost - but it is also a library: KamikazeGambit references it directly.

### KamikazeGambit - a real custom gambit

[`KamikazeGambit/`](KamikazeGambit/)

Adds a one-shot gambit: landing a piece on an enemy destroys both pieces.
Builds on `GambitApi` by passing its `GambitKamikaze` MonoBehaviour to
`.WithBaseGambit<T>()`. The interesting bits:

- `GambitKamikaze.cs` - the gambit's runtime behaviour. Subscribes to vanilla
  events, reads private state via reflection, and undoes the side-effects
  (e.g. restoring `tile.CanBeLandedOn` and `tile.PromoteColor`) cleanly.
- `KamikazeDebugHotkey.cs` - F8/F9 hotkeys for testing. Worth reading even if
  you don't ship debug hotkeys, because it shows how to inject a live gambit
  into a running game - useful pattern for any mod that wants to touch the
  active run.

### SpikesGambit - a didactic custom gambit by TGM

[`SpikesGambit/`](SpikesGambit/)

Adds `Spikes' Gambit`: enemy pieces that step on vanilla TRAP tiles are
captured instead of trapped. It is intentionally heavily commented so new
modders can see how to:

- Register a readable short gambit ID (`spikes`) for console commands like
  `give gambit spikes`.
- Use `TileManager.OnHunterTileUsed` instead of non-existent tile-mod APIs,
  preserving the TILE_EXHAUST strain automatically.
- Wait for vanilla movement tweens before destroying a piece, so particles
  spawn on the destination tile.
- Optionally load `Spike.png` from the mod folder, with a generated fallback
  sprite if no PNG is shipped.

### BetterCollection - a pure performance mod

[`BetterCollection/`](BetterCollection/)

Makes the gambit collection screen smooth. It changes no game logic at all - it
only rewrites how the existing UI is drawn, which makes it a good example of:

- Fixing a performance problem without Harmony: the whole mod is `enabled = false`
  on some components plus one field write, applied once.
- Doing nothing per frame. The work happens when the canvas is first found (while
  it is still inactive, so there is no visible pop); `Update` is one bool check.
- Being genuinely reversible, which is what `IModLifecycle` toggling requires -
  every component it touches is recorded with its original state first.
- Shipping a `config.json` plus a console command (`collection outlines <0-4>`)
  so the look/speed tradeoff can be dialled in live.

The problem it fixes: `UnityEngine.UI.Outline.ModifyMesh` appends four copies of
the *entire accumulated* vertex stream (x5), and `Shadow` appends one (x2). Stack
them on one graphic and they multiply. Vanilla's collection screen puts four
Outlines plus a Shadow on the page arrows - **x1250**, so a 6-vertex quad rebuilds
as 7,500 vertices - and 382 such components sit under a single 430-renderer canvas.
Keeping one outline per colour drops the screen's image geometry ~7x and looks
near-identical.

---

## Building & installing

```bash
# Build all samples and write distributables to <repo>/Mods/
./build.sh

# Build, then also install into the live Gambonanza/Mods/ directory
./build.sh --install
```

Each mod ends up as a self-contained folder containing:

```
Mods/<ModName>/
  Gambonanza.<ModName>.dll
  mod.json
  <assets, if any>
```

To distribute one of your own mods, just zip its folder. Anyone with the
patched game can drop it into their `Mods/` directory and it Just Works on
next launch.

---

## Writing your own mod, end to end

1. Make a new folder under `sample_mods/` (or anywhere - these samples are
   just one possible layout).

2. Add a `mod.json`:
   ```json
   { "id": "HelloMod", "name": "Hello Mod", "version": "1.0.0",
     "author": "you", "entry": "HelloMod.HelloEntry", "enabled": true,
     "gameVersion": ">=1.0", "description": "Logs a friendly message." }
   ```

3. Add a `.csproj` (copy `EnemyThreatOverlay/EnemyThreatOverlay.csproj` as a starting point - it already
   has the right reference paths into `../../refs/` and project references
   into `../../src/ModSdk/`).

4. Add a `.cs` file with a class implementing `IMod`:
   ```csharp
   using Gambonanza.ModSdk;
   using UnityEngine;
   namespace HelloMod
   {
       public sealed class HelloEntry : IMod
       {
           public void OnLoad(IModContext ctx)
           {
               Debug.Log("Hello from HelloMod!");
           }
       }
   }
   ```

5. Run `./build.sh --install`. The build script auto-discovers every folder
   under `sample_mods/` that has both a top-level `mod.json` and `.csproj`.
   The game picks it up on next launch.

---

## Common gotchas

- **No Harmony, no MonoMod.** If you need to alter vanilla behaviour, use
  reflection to read/write the private state, or attach a `MonoBehaviour` to
  the live target and watch fields each frame. `GambitApi/CollectionPaginationPatch.cs`
  is the canonical reference for the latter.

- **Singletons may not exist yet.** Anything that touches
  `SingletonMonoBehaviour<T>.Instance` from `OnLoad` will throw - `OnLoad`
  fires from `GameManager.Start`, before most other singletons are up. Defer
  with a coroutine, a `MonoBehaviour`, or `Application.onBeforeRender`.

- **Resources next to your DLL.** `IModContext.ModDirectory` is the
  authoritative place to find sprites, configs, etc. you ship with your mod.
  `Path.Combine(ctx.ModDirectory, "myasset.png")` works on every platform.

- **Texture loading.** For PNGs, prefer `ModGambitApi.LoadSprite(path)` (in
  GambitApi) or roll your own `Texture2D.LoadImage`. Unity's built-in
  `Resources.Load` will not see files that aren't part of the game's asset
  bundles.

- **`Object.FindObjectsOfType` warnings.** The samples still use it in a few
  places. The newer `FindObjectsByType` is fine to swap in if you'd prefer to
  silence the warning.
