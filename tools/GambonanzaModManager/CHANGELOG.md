# Changelog - Gambonanza Mod Manager

Release notes for the desktop app (tags `manager-v*`). The app shows the
relevant section in its update panel, and the release workflow refuses a tag
without a matching `package.json` version - keep both honest.

## 1.0.0

First release!

- Finds your Gambonanza install automatically (all Steam layouts, extra
  libraries included) - or point it at a folder.
- One-click patching with automatic backups, one-click restore.
- Browse the mod registry: install, update, disable and remove mods without
  touching a file. Downloads come straight from each mod's own GitHub
  releases and are checksum-verified before anything touches your game.
- Update notifications for the framework, your mods, and the app itself -
  with changelogs, and one-click re-patch when Steam updates the game.
- Publish tab for creators: sign in with GitHub, pick your repo and release,
  and the app opens the registry pull request for you.
- macOS (Apple Silicon + Intel), Windows and Linux.
