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

Builds are unsigned. macOS users right-click → Open on first launch; Windows
SmartScreen shows "More info → Run anyway". If a signing cert or Apple
developer account ever materialises, `electron-builder.yml` already has
`hardenedRuntime` on - add the identities and delete this paragraph.

## Registry

No releases - `registry/index.json` refreshes automatically (every 6 hours
and after every merge that touches `registry/mods/`). Force it from the
Actions tab → "Refresh registry index" → Run workflow.
