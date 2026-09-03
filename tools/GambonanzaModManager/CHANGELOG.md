# Changelog - Gambonanza Mod Manager

Release notes for the desktop app (tags `manager-v*`). The app shows the
relevant section in its update panel, and the release workflow refuses a tag
without a matching `package.json` version - keep both honest.

## 1.7.3

- **"Open submission on GitHub" now hands over the whole form.** The Registry
  id and the repository were arriving blank on the GitHub issue it opens, so
  you had to type both a second time. The id was never sent at all, and
  GitHub quietly discards a pre-filled field called `repo`, which is what the
  form's repository field happened to be named. Both now arrive filled in
  with the rest. Reported by Craftyman6 (#33).

## 1.7.2

- **Every mod, modpack and texture pack now has its own page** - in the app
  and on the website. In the app, click any card for the whole story:
  description, the gambits at full size, release notes, downloads, license,
  provenance. On the web, the same page lives at
  `bentrd.github.io/GambonanzaMods/mod/<id>/` with an **Open in Mod Manager**
  button that jumps straight to it in the app.
- **Deep links.** The app registers the `gmm://` scheme: `gmm://mod/<id>`,
  `gmm://modpack/<id>` and `gmm://texturepack/<id>` open the matching page,
  whether the app is already running or not. Links carry a registry id and
  nothing else - never a URL or a file - so a malicious link can name a page
  but can't smuggle anything onto your machine, and nothing installs without
  the same confirmation as always. A **Copy link** button on every page hands
  you the website URL, which is the one to paste in Discord (Discord doesn't
  linkify `gmm://`, and friends without the app land on a download button
  instead of nothing).
- **The Play button no longer does nothing on Linux.** It hands the launch to
  Steam as before, but if the desktop has no handler for `steam://` - common on
  Linux, and the case with a Flatpak Steam - the manager starts the game's own
  executable instead and says so. When Steam refuses the handoff outright, that
  now shows up as an error on the button rather than silence.
- Fixed a bogus "could not fetch ... redirect with no destination" warning in
  the activity log. The registry index is fetched with the cached tag attached,
  and the "nothing changed since last time" reply was being mistaken for a
  broken redirect - so every cached refresh logged a failure it had not had.

## 1.7.1

- **Wear several texture packs at once**, in an order you control. Worn packs
  move to the front of the shelf with a "worn 1st / 2nd" badge and a pair of
  ▲▼ arrows; where two of them change the same sprite or the same line, the
  higher one wins. Everything else stays where it was - one pack behaves
  exactly as before, and whatever you were wearing stays on.
- Under the hood this had to merge properly rather than layer. A pack's art is
  stored as WHOLE game sheets - 210 gambit icons on one 512x512 texture - so
  handing the game two packs that both touch that sheet would have let the
  second one paint over the first one's icon and silently lose it. The manager
  now resolves one winner per sprite and per string across the stack, then
  composites those onto the pristine sheet once. The game still receives a
  single pack and needs no update.
- A modpack remembers the whole stack, not one pack, so switching modpacks
  still switches the entire look. Shared modpacks carry the stack and its
  order, because the same two packs in the other order are a different setup.

## 1.7.0

- **Instances and modpacks are one thing now.** They were always the same idea
  seen from two ends - a named set of mods you switch between, and a named set
  of mods you install - so the Instances tab is gone and **My modpacks** does
  both. Your instances become modpacks on first launch, keeping their names,
  their mods and which one you were on; nothing to move, nothing to redo.
- **A modpack is your whole setup, texture pack included.** Each one remembers
  the pack it wears, so switching modpacks switches the look with the mods.
  Wear a texture pack and it belongs to the setup you are in, not to the app.
- **The contents panel.** The mods in a modpack are small squares now, laid out
  like the texture-pack tab: a mod's own first gambit sprite as its icon where
  it has one, everything else on hover, and a click for turn off / update /
  source / remove. Disabled mods stay visible, dimmed - "why isn't this
  loading" has an answer on screen.
- **Share your setup in one click.** The Share button on a modpack publishes
  what you actually have - the mods, in the versions you have, plus the
  texture pack you are wearing - and it is listed as soon as the submission is
  open, with no wait for a review. There is no list to curate any more: the old
  "add to modpack draft" dropdown in Browse is gone, because the thing worth
  sharing is the setup you already play.
- **Modpacks may contain unreviewed mods**, and say so. Any pack with one gets
  a small warning triangle wherever it appears, and installing it names them
  first. Previously packs could only hold reviewed mods, which quietly meant
  half of anyone's real setup could not be shared at all.
- **Installing someone's modpack builds it as its own modpack** and switches to
  it, so trying a stranger's loadout never disturbs yours. Its texture pack
  comes down with it. "Add to *my* modpack" is still one button away on the
  pack page.

## 1.6.0

- **Texture packs.** A new tab, and a whole second thing you can make: your
  own art and your own wording, layered over the game. Every sprite and
  texture the game ships is in there - all 200 gambit icons, both piece sets,
  every boss, the tiles, the title art - searchable and categorised, each with
  its original PNG a click away. Paint over one, drop it back in, and the
  pack updates immediately; there is no Apply button. The same tab does text:
  all 1229 of the game's strings in all 11 languages, with the game's own
  markup shown as chips so you keep it intact.
  Packs work like modpacks - a shelf of them, one worn at a time, switchable
  in a click - and share the same way: export one as a zip to hand to a
  friend, or publish it to the registry and let anyone install it. Downloads
  are pinned to the author's repository and checked against the checksum
  recorded at review time, exactly as mods are.
  This replaces the offline `tools/GambonanzaAssets` patcher, which needed
  Python, rewrote your game's asset files, and lost everything to a Steam
  update. Nothing is rewritten now: the framework applies the pack while the
  game runs. Needs framework 1.5.0.

## 1.5.0

- **See the actual gambits.** Mods that add gambits now show them the way
  the game does: the real sprite on a collection-style tile with a
  rarity-tinted halo and shop price tag, a hover card with the gambit's
  name, rarity capsule and description (in the game's own rarity colors and
  text markup, keyword colors included), and the game's hover wiggle. On
  a modpack's page a "gambits inside" shelf shows everything the pack puts
  in your runs; Browse cards and pack member rows carry mini tiles. The
  data comes from a new optional `gambits` field on registry entries, and
  sprites load straight from each mod's own repository.
- **Nicer notifications.** Toasts stopped piling up: repeats merge into a
  little bump, at most three show at once, each drains a timer bar, click
  dismisses, and exits collapse smoothly instead of popping.
- Gambit tiles are quiet by design - no background fill and light chrome,
  so every rarity's ray halo actually reads (epic's used to vanish into
  the old wine tile). Tooltips are opaque, always layer above neighboring
  cards, and nudge themselves inside the window instead of clipping at
  its edge.
- Instances tab badge counts instances, the prompt dialog got breathing
  room, pack-page buttons share a height, and modpacks no longer show a
  meaningless summed download count (per-mod counts remain).

## 1.4.0

- **Instances**: named mod loadouts, like profiles in a Minecraft launcher.
  Pick the instance to play from the new selector next to the Play button -
  switching swaps its mods into the game on the spot, so launching from
  Steam directly always loads what the manager shows. Installs go into the
  selected instance; every instance keeps its own copies. Create, rename
  and delete instances from the renamed **Instances** tab (previously "My
  mods"), which now also shows the selected instance's mod list.
- **Modpacks got a real detail page.** Pack cards are a teaser (summary,
  install state, first few mods) and clicking one opens the full view:
  every member as a proper row with its description, version, download
  stats, install state and source link, plus the pack's long description.
  The old everything-as-chips wall is gone.
- **New instance from a pack**: one button on the pack page creates a fresh
  instance, switches to it and installs the pack into it. The instance
  remembers which pack it came from.

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
