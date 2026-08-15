#!/bin/bash
# Builds the CollectionProfiler diagnostic mod and installs it into the live game's
# Mods/ folder. Kept out of sample_mods/ on purpose: this is a temporary measuring
# tool, not something to stage into the repo's distributable Mods/ or a release.
#
#   ./build-and-install.sh                        auto-detect the game
#   GAMBONANZA_DIR=/path ./build-and-install.sh
#   ./build-and-install.sh --uninstall            remove it again

set -euo pipefail

MOD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$MOD_DIR/../.." && pwd)"
MOD_ID="CollectionProfiler"

find_game_dir() {
    if [ -n "${GAMBONANZA_DIR:-}" ]; then
        [ -d "$GAMBONANZA_DIR" ] || { echo "GAMBONANZA_DIR does not exist: $GAMBONANZA_DIR" >&2; return 1; }
        printf '%s\n' "$GAMBONANZA_DIR"; return
    fi
    local candidates=(
        "$HOME/Library/Application Support/Steam/steamapps/common/Gambonanza"
        "$HOME/.local/share/Steam/steamapps/common/Gambonanza"
        "$HOME/.steam/steam/steamapps/common/Gambonanza"
        "/c/Program Files (x86)/Steam/steamapps/common/Gambonanza"
    )
    for c in "${candidates[@]}"; do
        [ -d "$c" ] && { printf '%s\n' "$c"; return; }
    done
    echo "Could not auto-detect a Gambonanza install. Set GAMBONANZA_DIR." >&2
    return 1
}

GAME_DIR="$(find_game_dir)"
DEST="$GAME_DIR/Mods/$MOD_ID"

if [ "${1:-}" = "--uninstall" ]; then
    rm -rf "$DEST"
    echo "Removed $DEST"
    exit 0
fi

if [ ! -d "$REPO_DIR/refs" ]; then
    echo "refs/ is missing - run ./build.sh once from $REPO_DIR to populate it." >&2
    exit 1
fi

echo "==> Building $MOD_ID"
dotnet build "$MOD_DIR/$MOD_ID.csproj" -c Release -v quiet --nologo

mkdir -p "$DEST"
cp "$MOD_DIR/bin/Release/Gambonanza.$MOD_ID.dll" "$DEST/"
cp "$MOD_DIR/mod.json" "$DEST/"

echo "==> Installed to $DEST"
echo
echo "Now: launch Gambonanza, open the collection, and browse for at least 40"
echo "seconds - turn pages and hover cards throughout. Then quit the game."
echo "(One full sweep lap is ~33s; staying longer just averages more laps.)"
echo
echo "The report lands at:"
echo "  $HOME/Library/Application Support/Blukulélé/Gambonanza/collection_profile.md"
echo "and a summary is echoed into Player.log."
