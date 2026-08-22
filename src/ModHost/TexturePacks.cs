using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Gambonanza.ModHost
{
    /// <summary>
    /// Texture packs: re-skins applied at runtime, with no patching of the game's
    /// asset files at all.
    ///
    /// A pack is data, not code - a folder next to Mods/ holding texturepack.json,
    /// one PNG per game texture it replaces, and a list of localised strings to
    /// override. The mod manager writes it; this reads it.
    ///
    /// Why runtime instead of rewriting resources.assets (which is what the older
    /// offline tool did):
    ///   - a Steam update can't wipe it, because nothing in the install changed;
    ///   - turning a pack off is deleting a folder, not restoring a 100 MB backup;
    ///   - no Python, no UnityPy, nothing to install;
    ///   - a pack is a zip anyone can share, exactly like a modpack.
    ///
    /// The whole image path is one call - Texture2D.LoadImage on the atlas the
    /// game already has loaded. Compositing an individual sprite into its sheet
    /// happens in the manager, where the pristine sheet and the sprite rectangle
    /// are both known, so nothing here has to read pixels back off the GPU or
    /// reason about sprite rects, packing rotation or colour space.
    /// </summary>
    internal static class TexturePacks
    {
        public const string DirName = "TexturePacks";
        public const string ManifestName = "texturepack.json";

        // ---- manifest -------------------------------------------------------

        internal class Manifest
        {
            public int FormatVersion;
            public string Id = "";
            public string Name = "";
            public string Author = "";
            public string Version = "";
            public string GameBuild = "";
            public List<TextureOverride> Textures = new List<TextureOverride>();
            public List<TextOverride> Texts = new List<TextOverride>();
        }

        internal class TextureOverride
        {
            /// <summary>The Unity object name of the texture to replace, e.g. "SPR_Gambits".</summary>
            public string Name;
            public string Label;
            public int Width;
            public int Height;
            public string Format;
            /// <summary>Pack-relative path of the replacement PNG, e.g. "atlases/spr-gambits.png".</summary>
            public string File;
        }

        internal class TextOverride
        {
            public string Section;
            public string Key;
            public List<TextValue> Values = new List<TextValue>();
        }

        internal class TextValue
        {
            /// <summary>Game language code (en, fr, ge, …), or "*" for every language.</summary>
            public string Lang;
            public string Value;
        }

        /// <summary>
        /// Read the manifest with our own parser rather than Unity's JsonUtility.
        /// JsonUtility was the obvious choice and it silently did half the job:
        /// the strings came back, the arrays of nested override classes came
        /// back empty, and nothing anywhere said why. A file mod authors will
        /// hand-edit deserves a reader that either works or names the problem.
        /// </summary>
        private static Manifest ReadManifest(string json)
        {
            var root = TinyJson.AsObject(TinyJson.Parse(json));
            if (root == null) throw new Exception("the manifest is not a JSON object");

            var manifest = new Manifest
            {
                FormatVersion = TinyJson.Int(root, "formatVersion", 1),
                Id = TinyJson.Str(root, "id", ""),
                Name = TinyJson.Str(root, "name", "Texture pack"),
                Author = TinyJson.Str(root, "author", ""),
                Version = TinyJson.Str(root, "version", ""),
                GameBuild = TinyJson.Str(root, "gameBuild", ""),
            };

            foreach (var raw in TinyJson.Array(root, "textures"))
            {
                var item = TinyJson.AsObject(raw);
                if (item == null) continue;
                var name = TinyJson.Str(item, "name");
                var file = TinyJson.Str(item, "file");
                if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(file)) continue;
                manifest.Textures.Add(new TextureOverride
                {
                    Name = name,
                    Label = TinyJson.Str(item, "label", name),
                    Width = TinyJson.Int(item, "width"),
                    Height = TinyJson.Int(item, "height"),
                    Format = TinyJson.Str(item, "format"),
                    File = file,
                });
            }

            foreach (var raw in TinyJson.Array(root, "texts"))
            {
                var item = TinyJson.AsObject(raw);
                if (item == null) continue;
                var section = TinyJson.Str(item, "section");
                var key = TinyJson.Str(item, "key");
                if (string.IsNullOrEmpty(section) || string.IsNullOrEmpty(key)) continue;
                var entry = new TextOverride { Section = section, Key = key };
                foreach (var rawValue in TinyJson.Array(item, "values"))
                {
                    var value = TinyJson.AsObject(rawValue);
                    if (value == null) continue;
                    var text = TinyJson.Str(value, "value");
                    if (string.IsNullOrEmpty(text)) continue;
                    entry.Values.Add(new TextValue { Lang = TinyJson.Str(value, "lang", "*"), Value = text });
                }
                if (entry.Values.Count > 0) manifest.Texts.Add(entry);
            }

            return manifest;
        }

        // ---- state ------------------------------------------------------------

        private static Manifest _manifest;
        private static string _packDir;
        private static ModConsole _console;
        private static bool _loaded;

        /// <summary>Instance ids of textures already replaced. Survives a reload of the
        /// same asset changing identity, which is the only case worth re-doing.</summary>
        private static readonly HashSet<int> _patchedIds = new HashSet<int>();

        /// <summary>Patched textures live only on the GPU once markNonReadable ran, so a
        /// stray unload would silently restore vanilla art. Hold them.</summary>
        private static readonly List<Texture2D> _pinned = new List<Texture2D>();

        private static readonly HashSet<string> _wantedTextureNames = new HashSet<string>(StringComparer.Ordinal);
        private static readonly HashSet<string> _appliedTextureNames = new HashSet<string>(StringComparer.Ordinal);

        /// <summary>Names we are done with, applied or given up on. A pack naming a
        /// texture this build no longer has must not keep the sweep running forever.</summary>
        private static readonly HashSet<string> _settledTextureNames = new HashSet<string>(StringComparer.Ordinal);

        /// <summary>Consecutive sweeps that found nothing new. The steady state is a
        /// game with every sheet already replaced; scanning it forever is waste.</summary>
        private static int _fruitlessPasses;
        private static readonly List<string> _problems = new List<string>();

        /// <summary>The traduction tree we last wrote into. A reparse hands back a new
        /// object, which is exactly how we notice our strings were thrown away.</summary>
        private static object _lastTraductionRoot;
        private static int _textsWritten;

        public static bool Active => _manifest != null;
        public static string PackName => _manifest?.Name ?? "";

        // ---- entry point ------------------------------------------------------

        /// <summary>
        /// Called from ModHost.LoadAll with the resolved Mods directory. The pack
        /// folder is its sibling, so a texture pack travels with the install the
        /// same way mods do.
        /// </summary>
        public static void Load(string modsDirectory, ModConsole console)
        {
            if (_loaded) return;
            _loaded = true;
            _console = console;

            try
            {
                _packDir = ResolvePackDir(modsDirectory);
                if (_packDir == null) return;

                var manifestPath = Path.Combine(_packDir, ManifestName);
                if (!File.Exists(manifestPath))
                {
                    ModHost.LogLine($"[TexturePacks] no pack installed ({manifestPath} not found).");
                    return;
                }

                _manifest = ReadManifest(File.ReadAllText(manifestPath));

                foreach (var t in _manifest.Textures) _wantedTextureNames.Add(t.Name);

                ModHost.LogLine($"[TexturePacks] \"{_manifest.Name}\" - {_manifest.Textures.Count} texture(s), {_manifest.Texts.Count} text override(s).");
                _console?.PrintInfo($"Texture pack \"{_manifest.Name}\" loaded - {_manifest.Textures.Count} image(s), {_manifest.Texts.Count} text(s). Type 'texturepack' for details.");

                TexturePackRunner.Spawn();
            }
            catch (Exception ex)
            {
                _manifest = null;
                ModHost.LogLine("[TexturePacks] failed to load: " + ex);
                _console?.PrintWarn("Texture pack failed to load: " + ex.Message);
            }
        }

        /// <summary>
        /// Turn a manifest-relative path into a real one, or null if it tries to
        /// leave the pack. Path.Combine happily returns an absolute second
        /// argument verbatim, so "/etc/passwd" in a shared pack would otherwise
        /// be read straight off disk.
        /// </summary>
        private static string ResolveInPack(string relative)
        {
            if (string.IsNullOrEmpty(relative)) return null;
            if (relative.IndexOfAny(Path.GetInvalidPathChars()) >= 0) return null;
            var cleaned = relative.Replace('\\', '/');
            if (cleaned.StartsWith("/") || cleaned.Contains(":")) return null;
            foreach (var part in cleaned.Split('/'))
                if (part == ".." || part == ".") return null;

            try
            {
                var root = Path.GetFullPath(_packDir);
                var full = Path.GetFullPath(Path.Combine(root, cleaned.Replace('/', Path.DirectorySeparatorChar)));
                var prefix = root.EndsWith(Path.DirectorySeparatorChar.ToString()) ? root : root + Path.DirectorySeparatorChar;
                return full.StartsWith(prefix, StringComparison.Ordinal) ? full : null;
            }
            catch { return null; }
        }

        /// <summary>Mods/ sits next to the executable; TexturePacks/ sits next to Mods/.</summary>
        private static string ResolvePackDir(string modsDirectory)
        {
            try
            {
                var env = Environment.GetEnvironmentVariable("GAMBONANZA_TEXTUREPACK_DIR");
                if (!string.IsNullOrEmpty(env)) return env;
                var parent = Path.GetDirectoryName(modsDirectory);
                return string.IsNullOrEmpty(parent) ? null : Path.Combine(parent, DirName);
            }
            catch { return null; }
        }

        public static void RegisterCommands(ModConsole console)
        {
            console.RegisterCommand("texturepack", "show the active texture pack and what it replaced", _ => PrintStatus(console));
            console.RegisterCommand("texturepack list", "list every override in the active texture pack", _ => PrintList(console));
            console.RegisterCommand("texturepack reapply", "re-apply the active texture pack right now", _ =>
            {
                if (!Active) { console.PrintWarn("No texture pack is installed."); return; }
                _patchedIds.Clear();
                _appliedTextureNames.Clear();
                _settledTextureNames.Clear();
                _pinned.Clear();
                _fruitlessPasses = 0;
                _problems.Clear();
                _lastTraductionRoot = null;
                int images = ApplyTextures();
                int texts = ApplyTexts();
                console.PrintInfo($"Re-applied: {images} image(s), {texts} text override(s).");
                foreach (var p in _problems) console.PrintWarn(p);
            });
        }

        private static void PrintStatus(ModConsole console)
        {
            if (!Active)
            {
                console.PrintInfo($"No texture pack installed. Drop one in {_packDir ?? "<Gambonanza>/" + DirName} - the mod manager does this for you.");
                return;
            }
            console.PrintInfo($"Texture pack: {_manifest.Name}"
                + (string.IsNullOrEmpty(_manifest.Author) ? "" : $" by {_manifest.Author}")
                + (string.IsNullOrEmpty(_manifest.Version) ? "" : $" v{_manifest.Version}"));
            console.PrintInfo($"  images: {_appliedTextureNames.Count}/{_manifest.Textures.Count} applied");
            console.PrintInfo($"  texts : {_textsWritten}/{_manifest.Texts.Count} written (current language {CurrentLanguageCode() ?? "?"})");
            if (!string.IsNullOrEmpty(_manifest.GameBuild)) console.PrintInfo($"  built against Steam build {_manifest.GameBuild}");
            foreach (var p in _problems) console.PrintWarn("  " + p);
        }

        private static void PrintList(ModConsole console)
        {
            if (!Active) { console.PrintInfo("No texture pack installed."); return; }
            foreach (var t in _manifest.Textures)
            {
                var mark = _appliedTextureNames.Contains(t.Name) ? "ok " : ".. ";
                console.PrintInfo($"  {mark} {t.Name}  {t.Width}x{t.Height} {t.Format}");
            }
            foreach (var t in _manifest.Texts)
                console.PrintInfo($"  txt  {t.Section}/{t.Key}");
        }

        /// <summary>Stop looking for this one - it either landed or never will.</summary>
        private static void Settle(string name) => _settledTextureNames.Add(name);

        // ---- the pass ---------------------------------------------------------

        /// <summary>One sweep. Cheap when there is nothing left to do.</summary>
        public static void Tick(bool rescanTextures)
        {
            if (!Active) return;
            try { ApplyTexts(); }
            catch (Exception ex) { Problem("text overrides failed: " + ex.Message); }

            // Nothing left to look for: every sheet either landed or was given up on.
            if (_settledTextureNames.Count >= _wantedTextureNames.Count) return;
            // Otherwise sweep while it is still paying off. A pack naming a texture
            // the game never loads would otherwise scan every loaded Texture2D every
            // five seconds for the rest of the session; a scene load (which is when
            // new sheets actually arrive) starts it up again.
            if (!rescanTextures && _fruitlessPasses >= FruitlessLimit) return;

            try
            {
                if (ApplyTextures() > 0) _fruitlessPasses = 0;
                else _fruitlessPasses++;
            }
            catch (Exception ex) { Problem("image overrides failed: " + ex.Message); }
        }

        /// <summary>Sweeps without a single hit before we stop until something changes.</summary>
        private const int FruitlessLimit = 12;

        /// <summary>A scene load brings new sheets in, so start looking again.</summary>
        public static void WakeUp() => _fruitlessPasses = 0;

        /// <summary>
        /// Replace every loaded texture the pack names. Textures stream in as scenes
        /// need them, so this runs repeatedly rather than once - a sheet that is not
        /// in memory yet simply gets picked up by a later pass.
        /// </summary>
        private static int ApplyTextures()
        {
            if (_wantedTextureNames.Count == 0) return 0;

            var byName = new Dictionary<string, TextureOverride>(StringComparer.Ordinal);
            foreach (var ov in _manifest.Textures) byName[ov.Name] = ov;

            int applied = 0;
            foreach (var tex in Resources.FindObjectsOfTypeAll<Texture2D>())
            {
                if (tex == null) continue;
                var name = tex.name;
                if (string.IsNullOrEmpty(name) || !byName.TryGetValue(name, out var ov)) continue;
                if (_patchedIds.Contains(IdOf(tex))) continue;

                // Dimensions must match exactly: every sprite on the sheet addresses
                // it in normalised UVs, so a resized sheet shifts all of them.
                if (ov.Width > 0 && (tex.width != ov.Width || tex.height != ov.Height))
                {
                    Problem($"{name}: pack image is {ov.Width}x{ov.Height} but the game's texture is {tex.width}x{tex.height} - skipped (regenerate the pack after a game update).");
                    _patchedIds.Add(IdOf(tex));
                    Settle(name);
                    continue;
                }

                if (ApplyOne(tex, ov)) applied++;
            }
            return applied;
        }

        private static bool ApplyOne(Texture2D tex, TextureOverride ov)
        {
            byte[] png;
            try
            {
                var file = ResolveInPack(ov.File);
                if (file == null) { Problem($"{ov.Name}: \"{ov.File}\" points outside the pack folder - ignored."); _patchedIds.Add(IdOf(tex)); Settle(ov.Name); return false; }
                if (!File.Exists(file)) { Problem($"{ov.Name}: {ov.File} is missing from the pack."); _patchedIds.Add(IdOf(tex)); Settle(ov.Name); return false; }
                png = File.ReadAllBytes(file);
            }
            catch (Exception ex) { Problem($"{ov.Name}: could not read {ov.File} ({ex.Message})"); return false; }

            // LoadImage re-creates the texture from the PNG, which resets sampler
            // state. In a pixel-art game losing filterMode=Point is the difference
            // between crisp icons and blurred mush, so capture and put it all back.
            var filter = tex.filterMode;
            var wrapU = tex.wrapModeU;
            var wrapV = tex.wrapModeV;
            var wrapW = tex.wrapModeW;
            var aniso = tex.anisoLevel;
            var bias = tex.mipMapBias;
            int w = tex.width, h = tex.height;

            // LoadImage RESIZES the texture to whatever the PNG says, and there is
            // no way back - every sprite on the sheet addresses it in normalised
            // UVs, so one wrong-sized image misaligns all 210 of them for the rest
            // of the session. Read the PNG's own header first and refuse rather
            // than wreck the atlas.
            if (!PngSizeMatches(png, w, h, out var pngW, out var pngH))
            {
                Problem($"{ov.Name}: the pack's image is {pngW}x{pngH} but the sheet is {w}x{h} - skipped.");
                _patchedIds.Add(IdOf(tex));
                Settle(ov.Name);
                return false;
            }

            bool ok;
            try
            {
                // markNonReadable: true, or every patched sheet keeps a permanent CPU
                // copy - 8 MB for a 2048x1024 one, for nothing.
                ok = tex.LoadImage(png, true);
            }
            catch (Exception ex)
            {
                Problem($"{ov.Name}: LoadImage threw ({ex.Message})");
                _patchedIds.Add(IdOf(tex));
                return false;
            }

            _patchedIds.Add(IdOf(tex));

            if (!ok)
            {
                Problem($"{ov.Name}: the engine refused the replacement image.");
                return false;
            }
            if (tex.width != w || tex.height != h)
            {
                Problem($"{ov.Name}: replacement resized the texture to {tex.width}x{tex.height} - sprites on this sheet are now misaligned.");
                return false;
            }

            try
            {
                tex.filterMode = filter;
                tex.wrapModeU = wrapU;
                tex.wrapModeV = wrapV;
                tex.wrapModeW = wrapW;
                tex.anisoLevel = aniso;
                tex.mipMapBias = bias;
            }
            catch { /* sampler state is cosmetic; never fail the swap over it */ }

            _pinned.Add(tex);
            _appliedTextureNames.Add(ov.Name);
            Settle(ov.Name);
            ModHost.LogLine($"[TexturePacks] replaced {ov.Name} ({w}x{h}, was {ov.Format ?? "?"}).");
            return true;
        }

        /// <summary>
        /// Read a PNG's IHDR without decoding it. Signature, then the two
        /// big-endian uint32s at offsets 16 and 20.
        /// </summary>
        private static bool PngSizeMatches(byte[] png, int width, int height, out int pngWidth, out int pngHeight)
        {
            pngWidth = pngHeight = 0;
            if (png == null || png.Length < 24) return false;
            if (png[0] != 0x89 || png[1] != 0x50 || png[2] != 0x4E || png[3] != 0x47) return false;
            pngWidth = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
            pngHeight = (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23];
            return pngWidth == width && pngHeight == height;
        }

        // ---- text overrides ---------------------------------------------------

        /// <summary>
        /// Write the pack's strings into the game's live translation tree.
        ///
        /// The tree is a cache: LocalizationManager re-parses it from the shipped
        /// TextAsset whenever the language changes, and nothing in the game is
        /// DontDestroyOnLoad, so a scene load rebuilds it too. Both throw our
        /// strings away, and one of the two (the Steam-language auto-detect on
        /// first launch) fires no event at all. So this is written to run over and
        /// over, and notices a rebuild by the identity of the returned root rather
        /// than by looking for a missing key - an overridden VANILLA key comes back
        /// non-empty after a reparse, it just comes back wrong.
        /// </summary>
        private static int ApplyTexts()
        {
            if (_manifest.Texts.Count == 0) return 0;

            var loc = LocalizationManagerInstance();
            if (loc == null) return 0;

            var root = GetTraduction(loc);
            if (root == null) return 0;
            if (ReferenceEquals(root, _lastTraductionRoot)) return _textsWritten;

            var lang = CurrentLanguageCode();
            int written = 0;
            foreach (var entry in _manifest.Texts)
            {
                var value = PickValue(entry, lang);
                // An empty override is worse than none: the game falls back to
                // printing the raw key in some places.
                if (string.IsNullOrEmpty(value)) continue;

                var section = Index(root, entry.Section);
                // A missing section hands back a JSONLazyCreator, which swallows one
                // write then throws on the next. Only touch sections that exist.
                if (section == null || section.GetType().Name == "JSONLazyCreator") continue;

                if (SetIndex(section, entry.Key, value)) written++;
            }

            _lastTraductionRoot = root;
            _textsWritten = written;
            if (written > 0)
            {
                ModHost.LogLine($"[TexturePacks] wrote {written} text override(s) for language {lang ?? "?"}.");
                // Text the game already drew is a plain string on a TMP component -
                // nothing re-reads the table on its own. Firing the game's own
                // language-changed action makes every subscribed widget re-read it,
                // so an override shows up now rather than whenever that screen
                // happens to be rebuilt.
                RefreshLiveText();
            }
            return written;
        }

        private static string PickValue(TextOverride entry, string lang)
        {
            string wildcard = null;
            foreach (var v in entry.Values)
            {
                if (v.Lang == "*") wildcard = v.Value;
                else if (lang != null && string.Equals(v.Lang, lang, StringComparison.OrdinalIgnoreCase)) return v.Value;
            }
            return wildcard;
        }

        /// <summary>Called after the pack is written, once, to nudge live UI into
        /// re-reading. Subscribers that throw abort the rest of the list, so this is
        /// best-effort and never allowed to escape.</summary>
        public static void RefreshLiveText()
        {
            try
            {
                var loc = LocalizationManagerInstance();
                var field = loc?.GetType().GetField("OnChangeLanguage", BindingFlags.Public | BindingFlags.Instance);
                (field?.GetValue(loc) as Action)?.Invoke();
            }
            catch { /* one bad subscriber is not our problem to fix */ }
        }

        // ---- game bindings (reflection: a renamed game type must degrade, not crash) ----

        private const BindingFlags Any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

        private static Type _locType, _jsonNodeType;
        private static PropertyInfo _jsonIndexer;
        private static MethodInfo _jsonFromString, _getTraduction;
        private static bool _bindingsResolved;

        private static void ResolveBindings()
        {
            if (_bindingsResolved) return;
            _bindingsResolved = true;
            _locType = GameType("Blukulele.CHE.LocalizationManager");
            _jsonNodeType = GameType("Blukulele.Core.JSONNode");
            if (_locType != null) _getTraduction = _locType.GetMethod("GetTraduction", Any);
            if (_jsonNodeType != null)
            {
                _jsonIndexer = _jsonNodeType.GetProperty("Item", new[] { typeof(string) });
                _jsonFromString = _jsonNodeType.GetMethods(BindingFlags.Public | BindingFlags.Static)
                    .FirstOrDefault(m => m.Name == "op_Implicit"
                        && m.ReturnType == _jsonNodeType
                        && m.GetParameters().Length == 1
                        && m.GetParameters()[0].ParameterType == typeof(string));
            }
            if (_locType == null || _getTraduction == null || _jsonIndexer == null || _jsonFromString == null)
                Problem("this game build does not expose the translation table the way the framework expects - text overrides are off.");
        }

        private static object LocalizationManagerInstance()
        {
            ResolveBindings();
            if (_locType == null) return null;
            try
            {
                var prop = _locType.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy)
                    ?? _locType.BaseType?.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static);
                var found = prop?.GetValue(null, null);
                if (found is UnityEngine.Object uo && uo != null) return found;
                // Singleton not assigned yet (or the scene was reloaded): fall back to
                // the object itself, inactive ones included.
                return Resources.FindObjectsOfTypeAll(_locType).FirstOrDefault(o => o != null);
            }
            catch { return null; }
        }

        private static object GetTraduction(object loc)
        {
            try { return _getTraduction?.Invoke(loc, null); }
            catch { return null; }
        }

        private static object Index(object node, string key)
        {
            try { return _jsonIndexer?.GetValue(node, new object[] { key }); }
            catch { return null; }
        }

        private static bool SetIndex(object node, string key, string value)
        {
            try
            {
                var boxed = _jsonFromString.Invoke(null, new object[] { value });
                _jsonIndexer.SetValue(node, boxed, new object[] { key });
                return true;
            }
            catch { return false; }
        }

        /// <summary>
        /// The game's own language codes, the ones the trad_&lt;code&gt; assets use.
        /// Matched on the enum's NAME so a reordered enum cannot silently swap
        /// languages, and so this compiles without referencing the game's types.
        /// </summary>
        private static readonly Dictionary<string, string> LanguageCodes = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            { "ENGLISH", "en" }, { "FRANCAIS", "fr" }, { "GERMAN", "ge" }, { "SPANISH", "sp" },
            { "JAPANESE", "jp" }, { "KOREAN", "ko" }, { "POLISH", "pl" }, { "PORTUGUESE", "pt_br" },
            { "RUSSIAN", "ru" }, { "SIMPLIFIED_CHINESE", "zh" }, { "TURKISH", "tr" },
        };

        private static string CurrentLanguageCode()
        {
            try
            {
                var dm = GameType("Blukulele.Core.DataManager");
                var instance = dm?.GetProperty("Instance", Any)?.GetValue(null, null)
                    ?? dm?.GetField("Instance", Any)?.GetValue(null);
                if (instance == null) return null;
                var settings = instance.GetType().GetProperty("SettingData", Any)?.GetValue(instance, null)
                    ?? instance.GetType().GetField("SettingData", Any)?.GetValue(instance);
                if (settings == null) return null;
                var lang = settings.GetType().GetProperty("CurrentLanguage", Any)?.GetValue(settings, null)
                    ?? settings.GetType().GetField("CurrentLanguage", Any)?.GetValue(settings);
                if (lang == null) return null;
                return LanguageCodes.TryGetValue(lang.ToString(), out var code) ? code : null;
            }
            catch { return null; }
        }

        /// <summary>Unity 6.1 renamed this to GetEntityId; the old name still works and
        /// keeps the framework compiling against older reference assemblies.</summary>
#pragma warning disable 0618
        private static int IdOf(UnityEngine.Object o) => o.GetInstanceID();
#pragma warning restore 0618

        private static Type GameType(string name) => AppDomain.CurrentDomain.GetAssemblies()
            .Select(a => a.GetType(name, throwOnError: false))
            .FirstOrDefault(t => t != null);

        /// <summary>Record a problem once, so a repeating pass cannot spam the log.</summary>
        private static void Problem(string message)
        {
            if (_problems.Contains(message)) return;
            _problems.Add(message);
            ModHost.LogLine("[TexturePacks] " + message);
            _console?.PrintWarn("Texture pack: " + message);
        }
    }

    /// <summary>
    /// Drives the passes. Textures stream in per scene and the translation table is
    /// rebuilt on scene load and language change, so "apply once at startup" is not
    /// a thing that works here - this keeps checking, quickly at first and lazily
    /// once everything has landed.
    /// </summary>
    internal sealed class TexturePackRunner : MonoBehaviour
    {
        private static TexturePackRunner _instance;
        private bool _rescan = true;

        public static void Spawn()
        {
            if (_instance != null) return;
            var go = new GameObject("GambonanzaTexturePacks") { hideFlags = HideFlags.HideAndDontSave };
            DontDestroyOnLoad(go);
            _instance = go.AddComponent<TexturePackRunner>();
        }

        private void OnEnable() => SceneManager.sceneLoaded += OnSceneLoaded;
        private void OnDisable() => SceneManager.sceneLoaded -= OnSceneLoaded;

        // A new scene brings new textures in and leaves LocalizationManager with an
        // empty cache, so both halves want a look.
        private void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            _rescan = true;
            TexturePacks.WakeUp();
        }

        private IEnumerator Start()
        {
            var eager = Time.realtimeSinceStartup + 90f;
            while (true)
            {
                bool rescan = _rescan || Time.realtimeSinceStartup < eager;
                _rescan = false;
                try { TexturePacks.Tick(rescan); }
                catch (Exception ex) { ModHost.LogLine("[TexturePacks] pass failed: " + ex.Message); }
                yield return new WaitForSecondsRealtime(Time.realtimeSinceStartup < eager ? 1f : 5f);
            }
        }
    }
}
