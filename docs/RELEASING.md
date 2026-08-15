# Releasing

Three release streams live in this repository, told apart by tag prefix:

| Stream | Tag | Built by | Consumed by |
| --- | --- | --- | --- |
| **Framework** (patcher + ModHost/ModSdk/GameUI + bundled mods) | `v1.2.3` | `.github/workflows/release.yml` | the mod manager's "framework update" check |
| **Mod manager** (the Electron app) | `manager-v1.2.3` | `.github/workflows/manager-release.yml` | the download site + the app's "app update" check |
| **Standalone mod** (a mod whose source we don't want in the tree) | `mod-<name>-v1.0.0` | by hand, see below | nothing automatic - players download it from the release page |

Both automated streams are matched **positively**, in
`tools/registry/build-index.mjs` and the manager's `config.js`. Do not
reintroduce "anything that isn't `manager-v*` is a framework release": that
classification published the first standalone mod release into the registry
index as a phantom framework build, which is what every player's update banner
reads.

Both checks surface the release **notes** to users as the changelog, so be
diligent: every release gets a real CHANGELOG section, written for players,
not for us.

## Framework release

One command, on a machine with Gambonanza installed (CI cannot compile the
framework DLLs - they reference the game's copyrighted assemblies, which only
exist next to an installed copy of the game):

```bash
tools/release-framework.sh 1.2.0
```

It builds against your game, stages the DLLs into `prebuilt/`, writes
`VERSION`, renames the CHANGELOG's `## Unreleased` section to the version
(and refuses to release without one - players see it as the release notes),
commits, tags `v1.2.0` and pushes. CI then packages
`gambonanza-framework-<rid>.zip` for all six platforms (the patcher is
compiled self-contained in CI - players never need .NET), zips every folder
in `Mods/`, and publishes the release. Managers everywhere notify their
users within six hours.

Update `GAME_BUILD` first if the supported game build changed.

## Mod manager release

1. Bump `version` in `tools/GambonanzaModManager/package.json`.
2. Add a section to `tools/GambonanzaModManager/CHANGELOG.md`.
3. Commit, then:

```bash
git tag manager-v1.1.0 && git push origin main manager-v1.1.0
```

CI builds the mac DMGs (arm64 + x64), the Windows installer and the Linux
AppImage, and attaches them all to one release. The download site picks the
right one per visitor automatically.

### Signing (status quo: none)

Builds are unsigned. Consequences, and the way out:

- **macOS** flags the downloaded app as "damaged" (Gatekeeper's wording for
  any unsigned, quarantined app - right-click → Open no longer bypasses it on
  current macOS). Users clear it once with
  `xattr -cr "/Applications/Gambonanza Mod Manager.app"` - the site's FAQ
  walks them through it. The real fix is an Apple Developer account
  ($99/year): create a Developer ID Application certificate, export it as a
  .p12, then add repository secrets and wire them into
  `manager-release.yml`'s mac build step
  (`CSC_LINK`/`CSC_KEY_PASSWORD` for signing; `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization, plus
  `notarize: true` under `mac:` in `electron-builder.yml` -
  `hardenedRuntime` is already on). After that, the dmg opens like any
  App Store download and the xattr FAQ entry can be deleted.
- **Windows** SmartScreen shows "More info → Run anyway" until enough
  downloads build reputation (or an EV certificate is bought).

## Standalone mod release

For a mod that should be downloadable from this repo without its source living
in the tree. Build it, zip the drop-in folder and the source separately, then:

```bash
gh release create mod-impatient-v1.0.0 \
  ImpatientGambit.zip ImpatientGambit-source.zip \
  --title "Impatient Gambit 1.0.0" --notes-file notes.md
```

The `mod-` prefix keeps it out of both automated streams and matches no
workflow trigger, so nothing is built or published on your behalf. Attach the
source archive as well - a binary in this repo without its source is exactly
what `docs/MOD_PUBLISHING.md` tells contributors not to do.

## Registry

No releases - `registry/index.json` refreshes automatically (every 6 hours
and after every merge that touches `registry/mods/`). Force it from the
Actions tab → "Refresh registry index" → Run workflow.
