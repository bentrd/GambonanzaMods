# Changelog - GambonanzaMods framework

Release notes for the modding framework (tags `v*`). Written for players: the
mod manager shows the relevant section when it offers an update, so say what
changed in terms of what they'll notice. The manager app keeps its own
changelog in `tools/GambonanzaModManager/CHANGELOG.md`.

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
