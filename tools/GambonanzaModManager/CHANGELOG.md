# Changelog - Gambonanza Mod Manager

Release notes for the desktop app (tags `manager-v*`). The app shows the
relevant section in its update panel, and the release workflow refuses a tag
without a matching `package.json` version - keep both honest.

## 1.0.3

- Update checks no longer touch GitHub's rate-limited API: the latest
  framework and app releases now travel inside the registry index (served
  from GitHub Pages, no limits). Heavy use can't produce "rate limit
  reached - try again in N minutes" any more; the API remains only as a
  fallback.
- The mod list can no longer travel back in time: right after a release,
  GitHub's CDN can briefly serve the previous registry index, which made
  fresh mods flip back to "coming soon". The app now keeps the newest index
  it has seen and falls back to a second source when a stale copy shows up.

## 1.0.2
- The app now updates itself: one click on "Update & restart" downloads the
  new version, verifies it, swaps it in and relaunches. No installer, no
  browser download - and on a Mac, no Gatekeeper theatre, because the app
  downloads updates itself. (The Terminal line remains a first-install-only
  ritual.)

## 1.0.1
- Fixed the enable/disable toggle rendering off-centre in its track.
- Buttons and pills that sit next to each other now share a consistent
  height (home screen, top bar, mod browser toolbar).
- Folders without a mod.json now show a clear label instead of a toggle
  that couldn't work.
- Library mods (like the Gambit Creation API) no longer clutter the mod
  shop - they install automatically with whatever needs them, and can't be
  removed while another installed mod depends on them. The "library" filter
  chip still shows them.

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
