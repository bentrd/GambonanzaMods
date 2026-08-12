# Releasing

Two release streams live in this repository, told apart by tag prefix:

| Stream | Tag | Built by | Consumed by |
| --- | --- | --- | --- |
| **Framework** (patcher + ModHost/ModSdk/GameUI + bundled mods) | `v1.2.3` | `.github/workflows/release.yml` | the mod manager's "framework update" check |
| **Mod manager** (the Electron app) | `manager-v1.2.3` | `.github/workflows/manager-release.yml` | the download site + the app's "app update" check |

Both checks surface the release **notes** to users as the changelog, so be
diligent: every release gets a real CHANGELOG section, written for players,
not for us.

## Framework release

CI cannot compile the framework DLLs (they reference the game's copyrighted
assemblies, which only exist next to an installed copy of the game), so a
maintainer refreshes the committed copies first:

```bash
# on a machine with Gambonanza installed
./build.sh --skip-samples                      # build against the live game
tools/package-framework.sh --stage-prebuilt    # copy DLLs into prebuilt/
```

Then:

1. Update `VERSION` (the release workflow refuses a tag that disagrees).
2. Add a `## <version>` section to `CHANGELOG.md` - user-facing wording;
   this becomes the release notes and shows up inside the mod manager.
3. Update `GAME_BUILD` if the supported game build changed.
4. Commit (`prebuilt/`, `VERSION`, `CHANGELOG.md`), then:

```bash
git tag v1.2.0 && git push origin main v1.2.0
```

CI packages `gambonanza-framework-<rid>.zip` for all six platforms (the
patcher is compiled self-contained in CI - players never need .NET), zips
every folder in `Mods/`, and publishes the release. Managers everywhere
notify their users within six hours.

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

## Registry

No releases - `registry/index.json` refreshes automatically (every 6 hours
and after every merge that touches `registry/mods/`). Force it from the
Actions tab → "Refresh registry index" → Run workflow.
