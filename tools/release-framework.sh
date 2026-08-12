#!/bin/bash
# One-command framework release, run on a machine with Gambonanza installed
# (and the dotnet SDK). Everything the release needs happens here:
#
#   tools/release-framework.sh 1.2.0
#
# which:
#   1. builds the framework against your game install (./build.sh)
#   2. stages the compiled DLLs into prebuilt/ for release CI
#   3. writes VERSION and finalises the CHANGELOG section
#   4. commits, tags v<version>, pushes both
#
# ...and CI does the rest: packages the per-platform patcher bundles, zips the
# bundled mods, and publishes the GitHub release the mod manager updates from.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NEW_VERSION="${1:-}"
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "usage: tools/release-framework.sh <version>     e.g. tools/release-framework.sh 1.2.0" >&2
    exit 2
fi

# prebuilt/ is excluded from the dirtiness check: this script regenerates it,
# so leftovers from an earlier (failed) run must not block a re-run.
if [ -n "$(git status --porcelain -- ':(exclude)prebuilt' 2>/dev/null || git status --porcelain)" ]; then
    echo "error: working tree has uncommitted changes - commit or stash them first," >&2
    echo "       so the release commit contains only what this script produces." >&2
    exit 1
fi

git fetch origin main
git merge --ff-only origin/main

if git rev-parse -q --verify "refs/tags/v$NEW_VERSION" >/dev/null; then
    echo "error: tag v$NEW_VERSION already exists" >&2
    exit 1
fi

# Changelog discipline FIRST, before any expensive or tree-mutating step:
# the Unreleased section becomes this version's section. If neither exists,
# stop - releases without notes are exactly what we promised users we
# wouldn't do.
if grep -q '^## Unreleased' CHANGELOG.md; then
    tmp="$(mktemp)"
    sed "s/^## Unreleased/## $NEW_VERSION/" CHANGELOG.md > "$tmp" && mv "$tmp" CHANGELOG.md
elif ! grep -Eq "^## \[?$NEW_VERSION" CHANGELOG.md; then
    echo "error: CHANGELOG.md has no '## Unreleased' or '## $NEW_VERSION' section." >&2
    echo "       Write one (players see it as the release notes), then re-run." >&2
    exit 1
fi

printf '%s\n' "$NEW_VERSION" > VERSION

echo "==> Building the framework against your game install"
./build.sh --skip-samples
tools/package-framework.sh --stage-prebuilt

git add prebuilt/ VERSION CHANGELOG.md
git commit -m "release: framework $NEW_VERSION"
git tag "v$NEW_VERSION"
git push origin main "v$NEW_VERSION"

echo
echo "Done - v$NEW_VERSION is tagged and CI is packaging the release:"
echo "  https://github.com/bentrd/GambonanzaMods/actions"
echo "In a few minutes the mod manager's 'Patch my game' and the sample mods go live."
