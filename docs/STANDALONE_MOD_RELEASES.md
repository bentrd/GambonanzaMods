# Standalone mod releases

How a mod gets published **from this repository** - built artefact and full
source - without its source code living in the tree.

This is a maintainer path, not the path for community mods. If you are
publishing your own mod, you want [MOD_PUBLISHING.md](MOD_PUBLISHING.md):
your mod lives in your repo, and the registry stores a pointer to it.

## Why

Some mods are written here, by the people who maintain the framework, and
would otherwise have nowhere to live but `sample_mods/`. That folder is
documentation: every mod in it is there because it teaches something about the
API, and it is built and shipped by `build.sh` and the framework release
workflow. A one-off gambit that nobody is going to read as a worked example
earns its place in neither.

But deleting the source is not an option either. The project's own rule for
community mods is *"public source in the linked repo, always - a mod without
public source doesn't get in"*, and a binary published by the framework
maintainers with no source attached is exactly the thing that rule exists to
prevent. Asking players to trust a DLL we won't show them would be worse
coming from us than from anyone else.

A release splits the difference. Releases are permanent, public, and carry
arbitrary attachments, so the source can ship *beside* the binary it built
without ever entering the tree:

- the tree stays what it claims to be - framework, tools, and sample mods that
  are genuinely samples
- the source is public, versioned, and downloadable by anyone who wants to
  audit the DLL before running it
- there is no third repository to create, name, maintain and keep in sync

The cost is that a standalone mod is not in the registry, so it has no
in-manager install or update button. Players download the zip and unpack it by
hand. If a mod outgrows that - if people are actually using it and want
updates - give it its own repository and a registry entry, which is what
`MOD_PUBLISHING.md` describes. Moving is cheap; the release history stays
where it is and the new repo starts clean.

## How

### 1. Build it

Develop the mod inside `sample_mods/<ModName>/` so the project's relative
references to `src/ModSdk`, `sample_mods/GambitApi` and `refs/` resolve:

```bash
dotnet build sample_mods/<ModName>/<ModName>.csproj -c Release
```

Include a `README.md` and a `LICENSE` in the mod folder. The README is the
only documentation the mod will ever have, so it should cover what the mod
does, what it depends on, and how to rebuild it from the archive.

### 2. Stage two archives

**The drop-in build** - what a player unpacks into `Gambonanza/Mods/`. One
folder, named exactly as the install folder:

```
<ModName>.zip
└── <ModName>/
    ├── mod.json
    ├── Gambonanza.<ModName>.dll
    └── <any assets, e.g. art.png>
```

**The source** - everything needed to rebuild that DLL, and nothing that was
built. No `bin/`, no `obj/`:

```
<ModName>-source.zip
└── <ModName>/
    ├── <ModName>.csproj
    ├── mod.json
    ├── README.md
    ├── LICENSE
    ├── src/*.cs
    └── tools/          (asset generators and the like, if any)
```

### 3. Tag it `mod-<name>-v<version>`

The prefix is load-bearing. This repository sorts releases into streams by tag
prefix (see [RELEASING.md](RELEASING.md)), and `mod-` keeps a standalone mod
out of both automated ones:

- it matches no workflow trigger, so nothing is built or published on your
  behalf - `release.yml` fires on `v*`, `manager-release.yml` on `manager-v*`
- `tools/registry/build-index.mjs` will not mistake it for a framework
  release, so it never reaches players' update banners

That second point was learned the hard way. The index builder used to pick the
framework release as "not a draft, not a pre-release, and not tagged
`manager-v*`", so the first standalone mod release published here would have
been written into `registry/index.json` as a phantom framework build, carrying
none of the framework assets - and that index is what every installed manager
reads. Both streams are matched positively now, but the tag prefix is still
the thing that keeps the lanes apart. Don't improvise a different one.

```bash
gh release create mod-impatient-v1.0.0 \
  ImpatientGambit.zip ImpatientGambit-source.zip \
  --title "Impatient Gambit 1.0.0" \
  --notes-file notes.md \
  --latest=false
```

`--latest=false` leaves the repository's "Latest" badge on the framework or
manager release, where players expect to find it.

### 4. Verify the source archive actually builds

Do this before you tell anyone the release exists. A source archive that
doesn't compile is worse than none: it looks like an audit trail and isn't
one. Download the published asset - not your local copy, the one GitHub is
serving - and build it in a clean slot:

```bash
curl -sL -o /tmp/src.zip "$(gh release view mod-<name>-v1.0.0 --json assets \
  --jq '.assets[]|select(.name|endswith("-source.zip"))|.url')"
unzip -q /tmp/src.zip -d /tmp/verify
mv /tmp/verify/<ModName> sample_mods/_verify
dotnet build sample_mods/_verify/<ModName>.csproj -c Release
rm -rf sample_mods/_verify
```

If the mod generates assets from a script, re-run it from the archive and
check the output matches the committed art byte for byte.

### 5. Remove the source from the tree

The whole point. Delete `sample_mods/<ModName>/` and confirm `git status` is
clean - the mod folder is untracked, so it is easy to leave behind, and
`sample_mods/build.sh` builds *every* folder it finds into `Mods/`, which
**is** tracked. A forgotten mod folder ends up committed via that route.

To work on the mod again, unzip the source asset back into
`sample_mods/<ModName>/`; that is the depth the project file expects.

## Does this need a framework release?

No, and it should not. A standalone mod is an ordinary mod DLL loaded by
`ModHost` at runtime - it ships nothing into `Managed/` and changes no
framework code. Players on the current framework can use it as soon as the
release is published. State the framework version and game build you tested
against in the release notes, because that is the compatibility contract, and
mention any framework mod it depends on (`GambitApi`, usually).

## Published this way

| Mod | Release |
| --- | --- |
| Impatient Gambit | [`mod-impatient-v1.0.0`](https://github.com/bentrd/GambonanzaMods/releases/tag/mod-impatient-v1.0.0) |
