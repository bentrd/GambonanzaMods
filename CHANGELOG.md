# Changelog - GambonanzaMods framework

Release notes for the modding framework (tags `v*`). Written for players: the
mod manager shows the relevant section when it offers an update, so say what
changed in terms of what they'll notice. The manager app keeps its own
changelog in `tools/GambonanzaModManager/CHANGELOG.md`.

## 1.3.2

- New mod - **Better Collection**: the collection screen runs smoothly now.
  Every card, button and arrow on that screen was being drawn over itself up
  to 1250 times to fake a thick outline - the two page arrows alone were
  rebuilt as 7,500 shapes each, every time anything on the screen moved - and
  that is what turned browsing your gambits into a slideshow. They are drawn
  twice now, which looks the same and costs a fraction as much. The run-info
  screen you open mid-run is built from the same pieces, so it got the same
  treatment. If you liked the chunkier outlines, `collection outlines 4` in
  the console (F10) puts them back exactly as they were.
- Better Collection also adds a **search bar to the collection**. Open it and
  just start typing - the grid filters as you go, with a suggestion list
  underneath (arrow keys to move through it, Tab or Enter to accept) and a
  match count on the right. It looks in gambit names and descriptions, so
  "trap" finds the Trap gambit first and then everything else that mentions
  traps, and loose typing like "gldidl" still finds Golden Idol.

## 1.3.1

- Custom gambits no longer show up chained and nameless in the collection. A
  gambit mod asking for a category the game doesn't recognise used to leave
  itself half-added to the library: it appeared as a permanently "Locked"
  card that nothing could unlock, your collection count went up by one for a
  gambit you could never get, and - worst of it - every gambit mod that
  loaded after it silently stopped working as well. GambitApi now corrects
  the bad category, and if the game still refuses the gambit it takes it back
  out cleanly, so one bad card can no longer take the others down with it.
  Gambit mods that had gone quiet should come back on their own after this
  update.

## 1.3.0

- Disabled mods are now COMPLETELY inert: the framework previously ran every
  mod's load code and only skipped its "enable" step, so mods doing their
  work at load (custom gambits, for one) ignored the toggle entirely. A
  disabled mod's DLL is no longer even loaded; enabling it from the manager
  or the console loads it on the spot.
- Gambit mods no longer haunt your save: uninstalling or disabling a custom
  gambit used to leave its unlock entry in the game's save data forever -
  the collection said "201/200" and showed stale entries. GambitApi now
  sweeps orphaned gambit ids out of the save on startup.
- Collection screen: the pagination patch no longer re-enforces slot
  visibility every frame (a frame-rate sink via constant UI layout
  rebuilds), and GambitApi logs a one-time frame-rate diagnostic the first
  time the collection stays open, so any remaining slowdown shows up in
  Player.log with numbers attached.
- SpeedMod retired: Gambonanza 1.4.0 added its own game-speed setting, so
  the mod is gone from the samples, the registry and future releases.

## 1.2.0

- The Gambonanza Mod Manager: a desktop app that patches the game, installs
  mods from the new registry, and keeps everything current - no terminal, no
  .NET SDK, no git. The `./build.sh` path still works exactly as before.
- Framework releases now ship pre-packaged per-platform bundles
  (`gambonanza-framework-<rid>.zip`) with a self-contained patcher.
- The in-game updater now recognises manager-made installs and points players
  at the app instead of suggesting `git pull`.

## 1.1.0

- Support Gambonanza build 24613134 (game v1.4.0).
- GambonanzaAssets: online asset catalogue linked from the README.

## 1.0.0

- First tagged framework: ModSdk, ModHost with in-game console (F10),
  GameUI Pixel helpers, Cecil patcher with automatic backup/restore, sample
  mods (SpeedMod, GambitApi, custom gambits, overlays).
