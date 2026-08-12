#!/bin/bash
# Packages a GambonanzaMods framework release: the per-platform bundles the
# Gambonanza Mod Manager downloads, plus one zip per bundled mod.
#
#   tools/package-framework.sh                  # package everything into dist/release/
#   tools/package-framework.sh --stage-prebuilt # copy locally-built framework DLLs into prebuilt/
#   tools/package-framework.sh --skip-patcher   # quick run without dotnet publish
#
# Two build inputs, because of who can build what:
#
#   * The three framework DLLs (ModSdk, ModHost, GameUI) compile against the
#     game's own assemblies, which are copyrighted and never leave a machine
#     that owns the game. So a maintainer builds them locally with ./build.sh,
#     then commits the results to prebuilt/ via --stage-prebuilt - exactly the
#     same convention as the pre-built mod DLLs already shipped in Mods/.
#
#   * The patcher only needs Mono.Cecil from NuGet, so anyone - including CI -
#     can compile it, self-contained, for every platform. Players do not need
#     .NET installed.
#
# The release workflow (.github/workflows/release.yml) runs this on every v*
# tag and attaches dist/release/* to the GitHub release.
#
# Bundle layout (consumed by the mod manager's framework.js):
#   gambonanza-framework-<rid>.zip
#     manifest.json        version / commit / file checksums
#     framework/*.dll      dropped into the game's Managed/
#     patcher/GambonanzaPatcher[.exe]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

VERSION="$(cat VERSION 2>/dev/null || printf '0.0.0')"
COMMIT="$(git rev-parse HEAD 2>/dev/null || printf 'unknown')"
OUT_DIR="$SCRIPT_DIR/dist/release"
PREBUILT_DIR="$SCRIPT_DIR/prebuilt"
RIDS=(osx-arm64 osx-x64 win-x64 win-arm64 linux-x64 linux-arm64)
SKIP_PATCHER=0
STAGE_PREBUILT=0

for arg in "$@"; do
    case "$arg" in
        --skip-patcher)   SKIP_PATCHER=1 ;;
        --stage-prebuilt) STAGE_PREBUILT=1 ;;
        -h|--help) sed -n '2,/^set -/p' "$0" | sed 's/^# \?//;/^set -/d'; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

FRAMEWORK_DLLS=(Gambonanza.ModSdk.dll Gambonanza.ModHost.dll Gambonanza.GameUI.dll)

# ----------------------------------------------------------------------------
# --stage-prebuilt: copy a fresh local build into prebuilt/ for committing
# ----------------------------------------------------------------------------

if [ "$STAGE_PREBUILT" -eq 1 ]; then
    mkdir -p "$PREBUILT_DIR"
    for pair in "src/ModSdk/bin/Release/Gambonanza.ModSdk.dll" \
                "src/ModHost/bin/Release/Gambonanza.ModHost.dll" \
                "src/GameUI/bin/Release/Gambonanza.GameUI.dll"; do
        if [ ! -f "$pair" ]; then
            echo "missing $pair - run ./build.sh first" >&2
            exit 1
        fi
        cp "$pair" "$PREBUILT_DIR/"
        echo "staged $(basename "$pair") -> prebuilt/"
    done
    cat > "$PREBUILT_DIR/README.md" <<EOF
# prebuilt/

The compiled framework DLLs, committed so that release CI (which cannot build
against the game's copyrighted assemblies) can package them. Refresh with:

    ./build.sh --skip-samples
    tools/package-framework.sh --stage-prebuilt

Built from this repository's MIT-licensed sources at the commit that changed
them; they contain no game code.
EOF
    echo "done. Commit prebuilt/ and tag the release."
    exit 0
fi

# ----------------------------------------------------------------------------
# Locate the framework DLLs: fresh local build first, then prebuilt/
# ----------------------------------------------------------------------------

resolve_dll() {
    local name="$1"
    local local_build=""
    case "$name" in
        Gambonanza.ModSdk.dll)  local_build="src/ModSdk/bin/Release/$name" ;;
        Gambonanza.ModHost.dll) local_build="src/ModHost/bin/Release/$name" ;;
        Gambonanza.GameUI.dll)  local_build="src/GameUI/bin/Release/$name" ;;
    esac
    if [ -n "$local_build" ] && [ -f "$local_build" ]; then
        printf '%s\n' "$local_build"
    elif [ -f "$PREBUILT_DIR/$name" ]; then
        printf '%s\n' "$PREBUILT_DIR/$name"
    else
        return 1
    fi
}

declare -a DLL_PATHS=()
for dll in "${FRAMEWORK_DLLS[@]}"; do
    if ! p="$(resolve_dll "$dll")"; then
        echo "error: cannot find $dll." >&2
        echo "  Either run ./build.sh on a machine with the game installed," >&2
        echo "  or make sure prebuilt/ is populated (tools/package-framework.sh --stage-prebuilt)." >&2
        exit 1
    fi
    DLL_PATHS+=("$p")
    echo "framework dll: $p"
done

# ----------------------------------------------------------------------------
# Build the patcher for every platform (self-contained single file)
# ----------------------------------------------------------------------------

PATCHER_OUT="$SCRIPT_DIR/dist/patcher"
if [ "$SKIP_PATCHER" -eq 0 ]; then
    command -v dotnet >/dev/null 2>&1 || { echo "dotnet SDK is required (or pass --skip-patcher)" >&2; exit 1; }
    for rid in "${RIDS[@]}"; do
        echo "==> Publishing patcher for $rid"
        dotnet publish src/Patcher -c Release -r "$rid" --self-contained \
            -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true \
            -p:DebugType=none --nologo -v minimal \
            -o "$PATCHER_OUT/$rid"
    done
fi

# ----------------------------------------------------------------------------
# Assemble the per-RID bundles
# ----------------------------------------------------------------------------

sha256_of() {
    if   command -v shasum    >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
    elif command -v sha256sum >/dev/null 2>&1; then sha256sum   "$1" | cut -d' ' -f1
    else printf 'unknown'
    fi
}

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

for rid in "${RIDS[@]}"; do
    exe="GambonanzaPatcher"
    case "$rid" in win-*) exe="GambonanzaPatcher.exe" ;; esac
    patcher_bin="$PATCHER_OUT/$rid/$exe"
    if [ ! -f "$patcher_bin" ]; then
        echo "warn: no patcher for $rid (skipping bundle)" >&2
        continue
    fi

    stage="$(mktemp -d)"
    mkdir -p "$stage/framework" "$stage/patcher"
    for p in "${DLL_PATHS[@]}"; do cp "$p" "$stage/framework/"; done
    cp "$patcher_bin" "$stage/patcher/"
    chmod +x "$stage/patcher/$exe" 2>/dev/null || true

    {
        echo '{'
        echo "  \"version\": \"$VERSION\","
        echo "  \"commit\": \"$COMMIT\","
        echo "  \"rid\": \"$rid\","
        echo "  \"builtAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
        echo '  "files": {'
        first=1
        while IFS= read -r f; do
            rel="${f#"$stage/"}"
            [ "$first" -eq 1 ] || echo ','
            first=0
            printf '    "%s": "%s"' "$rel" "$(sha256_of "$f")"
        done < <(command find "$stage" -type f ! -name manifest.json | sort)
        echo ''
        echo '  }'
        echo '}'
    } > "$stage/manifest.json"

    out_zip="$OUT_DIR/gambonanza-framework-$rid.zip"
    (cd "$stage" && zip -q -r "$out_zip" .)
    rm -rf "$stage"
    echo "bundle -> $out_zip"
done

# ----------------------------------------------------------------------------
# One zip per bundled mod, straight from the committed Mods/ folders
# ----------------------------------------------------------------------------

for mod_dir in Mods/*/; do
    [ -f "$mod_dir/mod.json" ] || continue
    name="$(basename "$mod_dir")"
    out_zip="$OUT_DIR/$name.zip"
    (cd Mods && zip -q -r "$out_zip" "$name")
    echo "mod    -> $out_zip"
done

echo
echo "Release artifacts in $OUT_DIR:"
ls -la "$OUT_DIR"
