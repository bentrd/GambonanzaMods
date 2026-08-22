#!/bin/bash
# One-shot installer. Does everything end-to-end:
#
#   1. Auto-detects the game install (override with GAMBONANZA_DIR or arg).
#   2. Hydrates refs/ from the game's own Managed/ folder so the projects
#      can compile (those DLLs are copyrighted and shipped with the game,
#      so we never commit them to the repo - we copy from your own install).
#   3. Builds the framework (ModSdk, ModHost, GameUI, Patcher).
#   4. Patches Assembly-CSharp.dll and installs the framework DLLs into
#      Managed/. Idempotent - always patches from the .orig backup.
#   5. Builds every sample mod under sample_mods/ and stages a clean
#      drop-in folder for each into <repo>/Mods/<ModName>/.
#   6. Copies the staged sample mod folders into the live game's Mods/.
#
# Cross-platform: works on macOS, Linux, and Windows under Git Bash / WSL.
#
# Usage:
#     ./build.sh                       # full install
#     ./build.sh --skip-samples        # framework only, leaves Mods/ empty
#     ./build.sh "/path/to/Gambonanza" # explicit install path
#     GAMBONANZA_DIR="/path" ./build.sh
#
# Requires: bash + dotnet SDK (>= 8.0).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REFS_DIR="$SCRIPT_DIR/refs"
FRAMEWORK_VERSION="$(cat "$SCRIPT_DIR/VERSION" 2>/dev/null || printf '1.0.0')"

SKIP_SAMPLES=0
GAME_ARG=""
for arg in "$@"; do
    case "$arg" in
        --skip-samples) SKIP_SAMPLES=1 ;;
        -h|--help)
            sed -n '2,/^set -/p' "$0" | sed 's/^# \?//;/^set -/d'
            exit 0
            ;;
        *) GAME_ARG="$arg" ;;
    esac
done

# ----------------------------------------------------------------------------
# 1. Locate the game install
# ----------------------------------------------------------------------------

normalize_path() {
    # Git Bash/MSYS accepts /d/foo reliably for shell file operations. A raw
    # Windows path like D:\SteamLibrary may be interpreted inconsistently by
    # bash tools even though native .NET tools can use it, causing the framework
    # to patch the real game while sample mods get copied elsewhere.
    local p="$1"
    case "$p" in
        [A-Za-z]:\\*)
            local drive="${p:0:1}"
            p="/${drive,,}/${p:3}"
            p="${p//\\//}"
            ;;
        [A-Za-z]:/*)
            local drive="${p:0:1}"
            p="/${drive,,}/${p:3}"
            ;;
    esac
    printf '%s\n' "$p"
}

find_game_dir() {
    if [ -n "${GAMBONANZA_DIR:-}" ]; then
        local normalized
        normalized="$(normalize_path "$GAMBONANZA_DIR")"
        [ -d "$normalized" ] || { echo "GAMBONANZA_DIR is set but does not exist: $GAMBONANZA_DIR (normalized: $normalized)" >&2; return 1; }
        printf '%s\n' "$normalized"
        return
    fi
    if [ -n "$GAME_ARG" ]; then
        local normalized
        normalized="$(normalize_path "$GAME_ARG")"
        if [ -d "$normalized" ]; then
            printf '%s\n' "$normalized"
            return
        fi
    fi
    local candidates=(
        "$HOME/Library/Application Support/Steam/steamapps/common/Gambonanza"
        "$HOME/.local/share/Steam/steamapps/common/Gambonanza"
        "$HOME/.steam/steam/steamapps/common/Gambonanza"
        "/c/Program Files (x86)/Steam/steamapps/common/Gambonanza"
        "/c/Program Files/Steam/steamapps/common/Gambonanza"
    )
    for c in "${candidates[@]}"; do
        [ -d "$c" ] && { printf '%s\n' "$c"; return; }
    done
    echo "Could not auto-detect a Gambonanza install." >&2
    echo "Pass the install path as an argument or set GAMBONANZA_DIR." >&2
    return 1
}

find_managed_dir() {
    local game="$1"
    local candidates=(
        "Gambonanza.app/Contents/Resources/Data/Managed"
        "Gambonanza_Data/Managed"
        "Gambonanza/Gambonanza_Data/Managed"
    )
    for sub in "${candidates[@]}"; do
        [ -d "$game/$sub" ] && { printf '%s\n' "$game/$sub"; return; }
    done
    echo "Could not find a Managed/ directory under $game." >&2
    echo "Tried: ${candidates[*]}" >&2
    return 1
}

derive_mods_dir() {
    local game="$1"
    local managed="$2"
    local data_dir runtime_dir
    data_dir="$(dirname "$managed")"
    if [ "$(basename "$data_dir")" = "Gambonanza_Data" ]; then
        # Windows/Linux layout: <runtime dir>/Gambonanza_Data/Managed.
        # If the user passed the Steam common wrapper folder, the real Mods folder
        # is one level deeper next to the executable, not next to the wrapper.
        runtime_dir="$(dirname "$data_dir")"
        printf '%s\n' "$runtime_dir/Mods"
    else
        # macOS .app layout: keep Mods next to Gambonanza.app.
        printf '%s\n' "$game/Mods"
    fi
}

GAME_DIR="$(find_game_dir)"
MANAGED_DIR="$(find_managed_dir "$GAME_DIR")"
MODS_DIR="$(derive_mods_dir "$GAME_DIR" "$MANAGED_DIR")"

echo "==> Game install:  $GAME_DIR"
echo "==> Managed/ dir:  $MANAGED_DIR"

# ----------------------------------------------------------------------------
# 2. Hydrate refs/ from the user's own Managed/ folder
# ----------------------------------------------------------------------------

# Every DLL the framework + sample mods reference at compile time. The user
# already has all of these on disk inside their own game install, so we copy
# them in rather than committing them to the repo (they are copyrighted by
# Unity / Blukulele and we have no right to redistribute them).
REQUIRED_REFS=(
    Assembly-CSharp-firstpass.dll
    DOTween.dll
    Unity.TextMeshPro.dll
    UnityEngine.dll
    UnityEngine.AnimationModule.dll
    UnityEngine.AudioModule.dll
    UnityEngine.CoreModule.dll
    UnityEngine.IMGUIModule.dll
    UnityEngine.ImageConversionModule.dll
    UnityEngine.InputLegacyModule.dll
    UnityEngine.JSONSerializeModule.dll
    UnityEngine.ParticleSystemModule.dll
    UnityEngine.Physics2DModule.dll
    UnityEngine.PhysicsModule.dll
    UnityEngine.SpriteMaskModule.dll
    UnityEngine.TextCoreTextEngineModule.dll
    UnityEngine.TextRenderingModule.dll
    UnityEngine.UI.dll
    UnityEngine.UIModule.dll
    com.rlabrecque.steamworks.net.dll
)

echo "==> Hydrating refs/ from $MANAGED_DIR"
mkdir -p "$REFS_DIR"

# Pick whichever Assembly-CSharp.dll is currently vanilla so mods compile against
# the live game's API surface. The patcher tags its output with a marker type
# (__GambonanzaModHostPatched); we grep for it as a literal string in the binary.
# NOTE: -a is required. Without it, BSD grep (macOS) refuses to report a match in
# a file it considers binary, so the marker check silently always said "vanilla"
# and refs/ got hydrated from the *patched* dll on every re-run.
#   - .dll WITHOUT marker = vanilla (first install OR Steam just shipped an update
#     that overwrote our patched DLL). Use it; .orig is potentially stale.
#   - .dll WITH marker = our patched output. Use .orig (which the patcher
#     guarantees is the matching vanilla snapshot).
ASMCSHARP="$MANAGED_DIR/Assembly-CSharp.dll"
ASMCSHARP_ORIG="$MANAGED_DIR/Assembly-CSharp.dll.orig"
MARKER="__GambonanzaModHostPatched"
if grep -aq "$MARKER" "$ASMCSHARP" 2>/dev/null; then
    if [ -f "$ASMCSHARP_ORIG" ]; then
        cp "$ASMCSHARP_ORIG" "$REFS_DIR/Assembly-CSharp.dll"
    else
        echo "  warn: $ASMCSHARP is patched but no .orig backup found. Using patched dll." >&2
        cp "$ASMCSHARP" "$REFS_DIR/Assembly-CSharp.dll"
    fi
else
    cp "$ASMCSHARP" "$REFS_DIR/Assembly-CSharp.dll"
fi

missing=()
for dll in "${REQUIRED_REFS[@]}"; do
    if [ -f "$MANAGED_DIR/$dll" ]; then
        cp "$MANAGED_DIR/$dll" "$REFS_DIR/$dll"
    else
        missing+=("$dll")
    fi
done

if [ "${#missing[@]}" -gt 0 ]; then
    echo "  refs/ hydration failed - these DLLs are not in $MANAGED_DIR:" >&2
    printf '    - %s\n' "${missing[@]}" >&2
    echo "  Has Steam fully installed the game?" >&2
    exit 1
fi
echo "  ok ($((${#REQUIRED_REFS[@]} + 1)) files)"

# ----------------------------------------------------------------------------
# 3. Build the framework
# ----------------------------------------------------------------------------

build_proj() {
    local proj="$1"
    echo "==> Building $(basename "$proj")"
    dotnet build "$SCRIPT_DIR/$proj" -c Release --nologo -v minimal
}

build_proj "src/ModSdk"
build_proj "src/GameUI"
build_proj "src/ModHost"
build_proj "src/Patcher"

MODSDK_DLL="$SCRIPT_DIR/src/ModSdk/bin/Release/Gambonanza.ModSdk.dll"
GAMEUI_DLL="$SCRIPT_DIR/src/GameUI/bin/Release/Gambonanza.GameUI.dll"
MODHOST_DLL="$SCRIPT_DIR/src/ModHost/bin/Release/Gambonanza.ModHost.dll"
PATCHER_DLL="$SCRIPT_DIR/src/Patcher/bin/Release/net8.0/GambonanzaPatcher.dll"

for f in "$MODSDK_DLL" "$GAMEUI_DLL" "$MODHOST_DLL" "$PATCHER_DLL"; do
    [ -f "$f" ] || { echo "missing build output: $f" >&2; exit 1; }
done

# ----------------------------------------------------------------------------
# 4. Patch the game
# ----------------------------------------------------------------------------

echo "==> Patching Assembly-CSharp.dll (installs ModSdk + ModHost + GameUI)"
dotnet "$PATCHER_DLL" "$MANAGED_DIR" "$MODSDK_DLL" "$MODHOST_DLL" "$GAMEUI_DLL"

COMMIT="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || printf 'unknown')"
json_escape() {
    # Keep the installer dependency-free: no Python/jq required just to write metadata.
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}
native_path() {
    # Paths under Git Bash (/d/...) are perfect for shell commands, but Unity/.NET
    # on Windows wants D:\... when it later tries Directory.Exists(). Store both.
    if command -v cygpath >/dev/null 2>&1; then
        cygpath -w "$1" 2>/dev/null || printf '%s' "$1"
    else
        printf '%s' "$1"
    fi
}
GAME_DIR_NATIVE="$(native_path "$GAME_DIR")"
MODS_DIR_NATIVE="$(native_path "$MODS_DIR")"

# Fingerprint the *vanilla* game code. The framework binds to a lot of private
# fields by name via reflection, so "which build was this verified against?" is
# the single most useful thing to record: when a Steam update breaks a mod, the
# first question is always whether the game changed underneath us.
sha256_of() {
    if   command -v shasum      >/dev/null 2>&1; then shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
    elif command -v sha256sum   >/dev/null 2>&1; then sha256sum   "$1" 2>/dev/null | cut -d' ' -f1
    else printf 'unknown'
    fi
}
GAME_HASH="$(sha256_of "$REFS_DIR/Assembly-CSharp.dll")"
GAME_HASH_SHORT="${GAME_HASH:0:12}"

# Steam records the installed build id in the app manifest two levels above
# steamapps/common/<game>. Absent for non-Steam copies - that's fine.
STEAM_BUILD="unknown"
_acf="$(dirname "$(dirname "$GAME_DIR")")/appmanifest_3509230.acf"
if [ -f "$_acf" ]; then
    STEAM_BUILD="$(sed -n 's/.*"buildid"[^"]*"\([0-9]*\)".*/\1/p' "$_acf" | head -n 1)"
    [ -n "$STEAM_BUILD" ] || STEAM_BUILD="unknown"
fi

cat > "$MANAGED_DIR/Gambonanza.ModHost.install.json" <<EOF
{
  "version": "$(json_escape "$FRAMEWORK_VERSION")",
  "commit": "$(json_escape "$COMMIT")",
  "repoDir": "$(json_escape "$SCRIPT_DIR")",
  "gameDir": "$(json_escape "$GAME_DIR")",
  "modsDir": "$(json_escape "$MODS_DIR")",
  "gameDirNative": "$(json_escape "$GAME_DIR_NATIVE")",
  "modsDirNative": "$(json_escape "$MODS_DIR_NATIVE")",
  "appId": "3509230",
  "gameAssemblySha256": "$(json_escape "$GAME_HASH")",
  "steamBuildId": "$(json_escape "$STEAM_BUILD")"
}
EOF
echo "  metadata -> $MANAGED_DIR/Gambonanza.ModHost.install.json (v$FRAMEWORK_VERSION, ${COMMIT:0:7})"
echo "  game build -> steam:$STEAM_BUILD  Assembly-CSharp:$GAME_HASH_SHORT"

# Compare against the build this checkout was last verified on. A mismatch is not
# an error - the framework usually survives a patch untouched - but it tells the
# user exactly what to suspect first if a mod starts misbehaving.
VERIFIED_FILE="$SCRIPT_DIR/GAME_BUILD"
if [ -f "$VERIFIED_FILE" ]; then
    VERIFIED_HASH="$(sed -n 's/^assemblySha256=//p' "$VERIFIED_FILE" | head -n 1)"
    VERIFIED_BUILD="$(sed -n 's/^steamBuildId=//p' "$VERIFIED_FILE" | head -n 1)"
    if [ -n "$VERIFIED_HASH" ] && [ "$VERIFIED_HASH" != "$GAME_HASH" ]; then
        echo "  note: this Gambonanza build (steam:$STEAM_BUILD) differs from the one the"
        echo "        framework was last verified against (steam:${VERIFIED_BUILD:-?}, ${VERIFIED_HASH:0:12})."
        echo "        Everything still installed. If a mod misbehaves, that's the first thing to check."
    fi
fi

mkdir -p "$MODS_DIR"

# ----------------------------------------------------------------------------
# 5. Build & install sample mods
# ----------------------------------------------------------------------------

if [ "$SKIP_SAMPLES" -eq 1 ]; then
    echo
    echo "Done. Framework installed; sample mods skipped (--skip-samples)."
    echo "Drop your own mod folders into $MODS_DIR/ and launch from Steam."
    exit 0
fi

DIST_DIR="$SCRIPT_DIR/Mods"
SAMPLES_DIR="$SCRIPT_DIR/sample_mods"
mkdir -p "$DIST_DIR"

echo "==> Discovering sample mods in: $SAMPLES_DIR"
echo "==> Sample mod install target: $MODS_DIR"

find_project_file() {
    local src="$1"
    local csproj
    csproj="$(command find "$src" -maxdepth 1 -name '*.csproj' -print | sort | head -n 1)"
    if [ -n "$csproj" ]; then printf '%s\n' "$csproj"; fi
    return 0
}

assembly_name_for() {
    local src="$1"
    local csproj asm
    csproj="$(find_project_file "$src")"
    [ -n "$csproj" ] || return 1
    asm="$(sed -n 's:.*<AssemblyName>\(.*\)</AssemblyName>.*:\1:p' "$csproj" | head -n 1)"
    if [ -n "$asm" ]; then printf '%s\n' "$asm"; else basename "${csproj%.csproj}"; fi
}

copy_extra_assets() {
    local src="$1"
    local out="$2"
    command find "$src" -maxdepth 1 -type f \
        ! -name 'mod.json' \
        ! -name '*.csproj' \
        ! -name '*.cs' \
        -print0 | while IFS= read -r -d '' asset; do
            cp "$asset" "$out/"
        done
}

found=0
for src in "$SAMPLES_DIR"/*; do
    [ -d "$src" ] || continue
    [ -f "$src/mod.json" ] || continue
    csproj="$(find_project_file "$src")"
    if [ -z "$csproj" ]; then
        echo "  skip $(basename "$src"): no .csproj at top level"
        continue
    fi

    found=1
    mod="$(basename "$src")"
    asm="$(assembly_name_for "$src")"
    out="$DIST_DIR/$mod"
    live="$MODS_DIR/$mod"

    echo "==> Building sample: $mod"
    dotnet build "$csproj" -c Release --nologo -v minimal

    dll="$src/bin/Release/$asm.dll"
    if [ ! -f "$dll" ]; then
        dll="$(command find "$src/bin/Release" -name "$asm.dll" -print | head -n 1)"
    fi
    [ -f "$dll" ] || { echo "missing build output for $mod (expected $asm.dll under $src/bin/Release)" >&2; exit 1; }

    rm -rf "$out" "$live"
    mkdir -p "$out" "$live"
    cp "$dll" "$out/"
    cp "$src/mod.json" "$out/"
    copy_extra_assets "$src" "$out"
    cp -R "$out/." "$live/"
    echo "  staged    -> $out"
    echo "  installed -> $live"
done

[ "$found" -eq 1 ] || { echo "No sample mods found under $SAMPLES_DIR" >&2; exit 1; }

installed_count="$(command find "$MODS_DIR" -mindepth 2 -maxdepth 2 -name mod.json -print | wc -l | tr -d ' ')"
echo
echo "Installed sample mod manifests found: $installed_count"
command find "$MODS_DIR" -mindepth 2 -maxdepth 2 -name mod.json -print | sort | sed 's/^/  - /'
echo
echo "All done. Sample mods installed in $MODS_DIR/."
echo "Launch the game from Steam - press F10, F1, or backtick to open"
echo "the in-game console. Type 'help' to list commands."
