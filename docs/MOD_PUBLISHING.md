# Publishing a mod

How your mod gets into the Gambonanza Mod Manager - and how updates reach
players automatically afterwards.

## The model in one paragraph

The registry ([`registry/mods/`](../registry/mods/)) never stores your mod's
files. It stores a **pointer**: your GitHub repository plus the name of the
release asset players should download. The mod manager downloads that asset
straight from *your* repo's Releases page, verifies its checksum, and unpacks
it into the game's `Mods/` folder. That means:

- **no hosting** - GitHub serves the downloads, free, forever
- **no upload step for updates** - publish a new GitHub release and every
  player's manager offers the update within a few hours
- **auditable by anyone** - the repo *is* the source; a mod without public
  source doesn't get in

## Step 1 - make the mod

Clone [GambonanzaMods](https://github.com/bentrd/GambonanzaMods), run
`./build.sh`, and copy a sample from `sample_mods/` as a starting point. A mod
is one .NET DLL plus a `mod.json`:

```json
{
  "id": "MyCoolMod",
  "name": "My Cool Mod",
  "version": "1.0.0",
  "author": "you",
  "entry": "MyCoolMod.Main",
  "enabled": true
}
```

`docs/UI_API.md` covers the in-game UI helpers; the sample mods double as
documentation for everything else.

## Step 2 - put it in a public GitHub repo

Source code at the top, however you like to organise it. Add a license
(MIT is the house style). If you started from a sample mod, you're done.

## Step 3 - publish a GitHub release

Zip your **built** mod folder so the archive contains one folder with
`mod.json` and the DLL inside:

```
MyCoolMod.zip
└── MyCoolMod/
    ├── mod.json
    └── MyCoolMod.dll
```

(A flat zip with `mod.json` at the root works too, as does a bare `.dll` if
you fill the `manifest` block in your registry entry - but the folder layout
above is the convention.)

On GitHub: **Releases → Draft a new release**, tag it (`v1.0.0`), attach the
zip, publish. That's the whole "upload".

> Tip: a GitHub Action in your own repo can build and attach the zip on every
> tag - copy `.github/workflows/release.yml` from any of the sample mod repos.

## Step 4 - submit to the registry

Two ways:

- **From a browser** (fastest): Publish tab → "Open submission on GitHub" (or
  use the [issue form](https://github.com/bentrd/GambonanzaMods/issues/new?template=mod-submission.yml)
  directly). A valid submission issue is listed in everyone's manager within
  the hour, marked **unreviewed** - players get warned that nobody has read
  the code yet and are pointed at your source.
- **From the mod manager**: Publish tab → Sign in with GitHub → pick your
  repo and release asset → Submit. The manager forks, commits and opens a
  registry pull request for you; your mod is listed once it's merged.

Either way, a maintainer then reviews your source - mostly a sanity read and
a check that the release asset matches it. A passing review adds the entry to
the registry, closes the submission issue, and swaps the listing to the
**reviewed** badge; the next index refresh records your asset's SHA-256 that
players' installs are verified against.

## Updates

Publish a new GitHub release with the same asset name (or matching your
glob, e.g. `MyCoolMod-*.zip`). Nothing else. The registry refresh picks up the
new release, and players get an Update button.

**Please keep release notes.** The manager shows your release body as the
changelog; "fixed stuff" helps nobody.

## Rules

- public source in the linked repo, always
- no network calls, telemetry, or file access outside the game folder
- the release asset must be built from the repo's source
- registry `id` and install `folder` are permanent once merged (players'
  installs key off them)

Entries that stop meeting these get removed; a removed entry's mods stop
installing but nothing already on players' disks is touched.

## Registry entry reference

See [`registry/schema.json`](../registry/schema.json) for every field. The
usual entry is just:

```json
{
  "id": "my-cool-mod",
  "name": "My Cool Mod",
  "author": "you",
  "summary": "Makes the queen breathe fire on Tuesdays.",
  "repo": "you/my-cool-mod",
  "asset": "MyCoolMod.zip",
  "folder": "MyCoolMod",
  "tags": ["gameplay"]
}
```

Validate locally with `node tools/registry/validate.mjs`.

## Download counts

Every mod card shows a lifetime download count and a popularity icon (hot /
popular / growing, relative to the rest of the registry). The numbers come
straight from GitHub's per-asset download counters - the registry refresh
records them into the index every hour. There is no analytics service and no
tracking anywhere: if you can see your release's download count on your own
repo's Releases page, that's the exact number the manager shows.

## Modpacks

A modpack is a curated bundle: a name, a blurb, and the registry ids of 2-24
mods. Packs contain **no code** - installing one installs its members through
the exact same checksum-verified path as installing them one by one, and
dependencies come along automatically. Packs may only reference **reviewed**
registry mods, never open submissions.

Publishing works from the manager's **Modpacks** tab:

- **Signed in with GitHub**: pick the mods, name the pack, Submit - the
  manager opens a registry pull request adding
  `registry/modpacks/<id>.json` for you.
- **Without sign-in**: "Open submission on GitHub" pre-fills a
  [modpack issue](https://github.com/bentrd/GambonanzaMods/issues/new?template=modpack-submission.yml);
  a maintainer checks the ids and commits the file.

Because a pack is pure metadata over already-reviewed mods, the review is
just "are these ids real" - there is no unreviewed-listing stage like mods
have. See [`registry/modpack-schema.json`](../registry/modpack-schema.json)
for the format.

## For the maintainer: enabling in-app sign-in

"Sign in with GitHub" uses the OAuth **device flow**, which needs a client id
but no secret. One-time setup:

1. GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App
   (name it "Gambonanza Mod Manager", any URLs - the device flow ignores the
   callback).
2. In the app's settings, tick **Enable Device Flow**.
3. Put the client id in the `GAMBONANZA_GITHUB_CLIENT_ID` repository secret;
   the manager-release workflow bakes it into builds via
   `tools/GambonanzaModManager/src/main/config.js`.

Until that's configured, the Publish tab simply hides the sign-in button and
uses the pre-filled issue path, which needs nothing.
