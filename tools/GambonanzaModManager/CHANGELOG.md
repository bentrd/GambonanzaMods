# Changelog - Gambonanza Mod Manager

Release notes for the desktop app (tags `manager-v*`). The app shows the
relevant section in its update panel, and the release workflow refuses a tag
without a matching `package.json` version - keep both honest.

## 1.3.1

- Installing or updating a mod now also updates its dependencies when they
  are behind the registry. Until now a library another mod relied on (the
  Gambit Creation API, say) stayed at whatever version you first installed,
  and an old library quietly breaks the mods built against a newer one -
  gambits showing up with no name or description, for example. Manually
  installed mods without a registry receipt are still left untouched.

## 1.3.0

- New **Modpacks** tab. Browse curated bundles of registry mods and install
  a whole pack in one click - already-installed mods are left alone,
  dependencies come along automatically, and every member is checksum
  verified exactly as if installed by itself. Publish your own pack from the
  same tab: sign in with GitHub and the manager opens the registry pull
  request, or grab the pre-filled submission issue without signing in.
  Packs can only contain reviewed registry mods - never unreviewed
  submissions.
- Mod cards grew an **add to modpack** dropdown: build a pack draft while
  you browse, then finish and submit it from the Modpacks tab.

## 1.2.0

- Every mod card now shows how many times the mod has been downloaded, plus
  a popularity icon: a flame for the registry's most-downloaded fifth, a
  star for the top half, a sprout for everything still growing. The counts
  are GitHub's own per-release-asset download counters, recorded into the
  registry index by CI every hour - no analytics service, no tracking, and
  nothing new phoning home.

## 1.1.0

- Community submissions show up in Browse the moment they're submitted,
  marked **unreviewed** - straight from their submission issue, before a
  maintainer has read the code. Installing (or updating) one warns you that
  nobody has checked it and points you at the source.
- The gold badge is now **reviewed** and replaces "official": it means a
  human read the mod's source before it was listed, which is true of every
  registry mod - bundled or community-made.

## 1.0.6

- New knight. The app icon, the header logo and the website all wear the
  redrawn brand knight - same wine-and-cream palette, sharper profile, and
  an ear it was sorely missing.

## 1.0.5

- "Check again" actually checks again: update checks now force a registry
  revalidation instead of answering from the 30-minute cache, so a fresh
  framework release shows up the moment you ask (an unchanged index costs
  one 304 round-trip).

## 1.0.4

- Downloads retry themselves once on transient network hiccups (the
  "fetch failed - clicked again and it worked" class). Checksum failures
  and cancellations still stop immediately.

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
