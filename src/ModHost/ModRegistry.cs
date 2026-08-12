using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Gambonanza.ModSdk;
using UnityEngine;

namespace Gambonanza.ModHost
{
    internal sealed class ModRegistry
    {
        private readonly List<LoadedMod> _mods = new List<LoadedMod>();
        private readonly Dictionary<string, LoadedMod> _byId = new Dictionary<string, LoadedMod>();
        private readonly HashSet<string> _seenDirs = new HashSet<string>();

        public IReadOnlyList<LoadedMod> Mods => _mods;
        public int Count => _mods.Count;

        // ----- Keybinds -----------------------------------------------------

        public IEnumerable<KeybindInfo> AllKeybinds(string modId = null)
        {
            foreach (var mod in _mods)
            {
                if (!string.IsNullOrEmpty(modId) && !string.Equals(mod.Manifest.id, modId, StringComparison.OrdinalIgnoreCase)) continue;
                foreach (var kb in EffectiveKeybinds(mod.Manifest))
                    yield return new KeybindInfo { ModId = mod.Manifest.id, Name = kb.name, Description = kb.description, Key = NormalizeKey(kb.key) };
            }
        }

        public bool TrySetKeybind(string modId, string name, string key, out string error)
        {
            error = null;
            var mod = _mods.FirstOrDefault(m => string.Equals(m.Manifest.id, modId, StringComparison.OrdinalIgnoreCase));
            if (mod == null) { error = "mod not loaded"; return false; }
            if (string.IsNullOrWhiteSpace(name)) { error = "missing keybind name"; return false; }
            EnsureKeybindArray(mod.Manifest);
            var kb = mod.Manifest.keybinds.FirstOrDefault(k => string.Equals(k.name, name, StringComparison.OrdinalIgnoreCase));
            if (kb == null) { error = $"'{mod.Manifest.id}' has no keybind named '{name}'"; return false; }
            kb.key = NormalizeKey(key);
            WriteManifest(mod);
            return true;
        }

        public string GetKeybind(string modId, string name)
        {
            var mod = _mods.FirstOrDefault(m => string.Equals(m.Manifest.id, modId, StringComparison.OrdinalIgnoreCase));
            if (mod == null || string.IsNullOrWhiteSpace(name)) return ModKeybinds.Unset;
            var kb = EffectiveKeybinds(mod.Manifest).FirstOrDefault(k => string.Equals(k.name, name, StringComparison.OrdinalIgnoreCase));
            return NormalizeKey(kb?.key);
        }

        private static IEnumerable<ModKeybindManifest> EffectiveKeybinds(ModManifest manifest)
        {
            EnsureKeybindArray(manifest);
            return manifest.keybinds;
        }

        private static void EnsureKeybindArray(ModManifest manifest)
        {
            var existing = manifest.keybinds == null
                ? new List<ModKeybindManifest>()
                : manifest.keybinds.Where(k => k != null && !string.IsNullOrWhiteSpace(k.name)).ToList();

            foreach (var known in KnownDefaultKeybinds(manifest.id))
            {
                if (!existing.Any(k => string.Equals(k.name, known.name, StringComparison.OrdinalIgnoreCase)))
                    existing.Add(known);
            }

            if (!existing.Any(k => string.Equals(k.name, "toggle", StringComparison.OrdinalIgnoreCase)))
                existing.Insert(0, new ModKeybindManifest { name = "toggle", description = "default toggle", key = ModKeybinds.Unset });

            manifest.keybinds = existing.ToArray();
        }

        private static IEnumerable<ModKeybindManifest> KnownDefaultKeybinds(string modId)
        {
            if (string.Equals(modId, "EnemyThreatOverlay", StringComparison.OrdinalIgnoreCase))
                yield return new ModKeybindManifest { name = "threatDisplay", description = "hold to show enemy threat overlay", key = "Space" };
        }

        private static string NormalizeKey(string key) => ModKeybinds.IsUnset(key) ? ModKeybinds.Unset : key.Trim();

        public sealed class KeybindInfo
        {
            public string ModId;
            public string Name;
            public string Description;
            public string Key;
        }

        // ----- Initial load -------------------------------------------------

        public void LoadMod(string modDirectory, ModManifest manifest)
        {
            _seenDirs.Add(modDirectory);

            // A disabled mod must be completely inert - most mods do their real
            // work (registering gambits, spawning runners) in OnLoad, which
            // LoadAndConstruct invokes. So for enabled:false we don't load the
            // assembly at all; a shell entry keeps the mod visible to the
            // console so `enable <id>` can construct it on demand.
            if (!manifest.enabled)
            {
                var shell = new LoadedMod
                {
                    Manifest     = manifest,
                    ManifestPath = Path.Combine(modDirectory, "mod.json"),
                    Directory    = modDirectory,
                    Instance     = null,
                    Lifecycle    = null,
                    Context      = null,
                    Assembly     = null,
                    IsActive     = false,
                };
                _mods.Add(shell);
                _byId[manifest.id] = shell;
                ModHost.LogLine($"'{manifest.id}' is disabled - not loaded (enable it in the mod manager or console to load it).");
                return;
            }

            var loaded = LoadAndConstruct(modDirectory, manifest);
            _mods.Add(loaded);
            _byId[loaded.Manifest.id] = loaded;
            ModHost.LogLine($"loaded '{manifest.id}' v{manifest.version} (entry={manifest.entry})");

            loaded.IsActive = true;
            if (loaded.Lifecycle != null)
            {
                try { loaded.Lifecycle.OnEnable(); }
                catch (Exception ex) { loaded.Context.LogLine("OnEnable threw: " + ex); }
            }
        }

        // ----- Hot toggle ---------------------------------------------------

        public bool TryDisable(string modId, out string error)
        {
            error = null;
            if (!_byId.TryGetValue(modId, out var mod)) { error = "mod not loaded"; return false; }
            if (!mod.IsActive) return true;
            mod.IsActive = false;
            mod.Manifest.enabled = false;
            WriteManifest(mod);
            if (mod.Lifecycle == null) { error = "mod has no IModLifecycle; restart required to fully disable"; return true; }
            try { mod.Lifecycle.OnDisable(); }
            catch (Exception ex) { error = "OnDisable threw: " + ex.Message; mod.Context.LogLine(error); }
            return true;
        }

        public bool TryEnable(string modId, out string error)
        {
            error = null;
            if (!_byId.TryGetValue(modId, out var mod)) { error = "mod not loaded"; return false; }
            if (mod.IsActive) return true;

            // Skipped at startup because it was disabled - construct it now
            // (this runs the mod's OnLoad for the first time).
            if (mod.Instance == null)
            {
                try
                {
                    var constructed = LoadAndConstruct(mod.Directory, mod.Manifest);
                    mod.Instance  = constructed.Instance;
                    mod.Lifecycle = constructed.Lifecycle;
                    mod.Context   = constructed.Context;
                    mod.Assembly  = constructed.Assembly;
                    ModHost.LogLine($"loaded '{mod.Manifest.id}' v{mod.Manifest.version} on enable (entry={mod.Manifest.entry})");
                }
                catch (Exception ex)
                {
                    error = $"could not load '{modId}': {ex.Message}";
                    return false;
                }
            }

            mod.IsActive = true;
            mod.Manifest.enabled = true;
            WriteManifest(mod);
            if (mod.Lifecycle == null) { error = "mod has no IModLifecycle; restart required to fully enable"; return true; }
            try { mod.Lifecycle.OnEnable(); }
            catch (Exception ex) { error = "OnEnable threw: " + ex.Message; mod.Context.LogLine(error); }
            return true;
        }

        // ----- Rescan for newly-added mods ----------------------------------

        public int Rescan(string modsDir)
        {
            if (!Directory.Exists(modsDir)) return 0;
            int newlyLoaded = 0;
            foreach (var dir in Directory.GetDirectories(modsDir))
            {
                if (_seenDirs.Contains(dir)) continue;
                _seenDirs.Add(dir);
                var manifestPath = Path.Combine(dir, "mod.json");
                if (!File.Exists(manifestPath)) continue;
                try
                {
                    var json = File.ReadAllText(manifestPath);
                    var manifest = ModManifest.TryParse(json, out var parseErr);
                    if (manifest == null) { ModHost.LogLine($"rescan: invalid mod.json in {dir}: {parseErr}"); continue; }
                    if (!manifest.IsValid(out var validErr)) { ModHost.LogLine($"rescan: invalid manifest in {dir}: {validErr}"); continue; }
                    LoadMod(dir, manifest);
                    newlyLoaded++;
                }
                catch (Exception ex) { ModHost.LogLine($"rescan: failed to load {dir}: {ex.Message}"); }
            }
            return newlyLoaded;
        }

        // ----- Event dispatch -----------------------------------------------

        public void DispatchSettingsOpened(MonoBehaviour settingsCanvas)
        {
            for (int i = 0; i < _mods.Count; i++)
            {
                var m = _mods[i];
                if (!m.IsActive) continue;
                m.Context.RaiseSettingsOpened(settingsCanvas);
            }
        }

        // ----- Internals ----------------------------------------------------

        private LoadedMod LoadAndConstruct(string modDirectory, ModManifest manifest)
        {
            var dlls = Directory.GetFiles(modDirectory, "*.dll", SearchOption.TopDirectoryOnly);
            if (dlls.Length == 0)
                throw new FileNotFoundException($"No .dll files in {modDirectory}");

            Type entryType = null;
            Assembly loadedAsm = null;
            foreach (var dll in dlls)
            {
                Assembly asm;
                try { asm = Assembly.LoadFrom(dll); }
                catch (Exception ex)
                {
                    ModHost.LogLine($"[{manifest.id}] could not load '{Path.GetFileName(dll)}': {ex.Message}");
                    continue;
                }
                var t = asm.GetType(manifest.entry, throwOnError: false);
                if (t != null) { entryType = t; loadedAsm = asm; break; }
            }

            if (entryType == null)
                throw new TypeLoadException($"Entry type '{manifest.entry}' not found in any DLL under {modDirectory}");
            if (!typeof(IMod).IsAssignableFrom(entryType))
                throw new InvalidCastException($"{manifest.entry} does not implement Gambonanza.ModSdk.IMod");

            var instance = (IMod)Activator.CreateInstance(entryType);
            var ctx = new ModContext(manifest.id, modDirectory, ModConsole.Instance);
            try { instance.OnLoad(ctx); }
            catch (Exception ex) { ctx.LogLine("OnLoad threw: " + ex); }

            return new LoadedMod
            {
                Manifest      = manifest,
                ManifestPath  = Path.Combine(modDirectory, "mod.json"),
                Directory     = modDirectory,
                Instance      = instance,
                Lifecycle     = instance as IModLifecycle,
                Context       = ctx,
                Assembly      = loadedAsm,
                IsActive      = false,
            };
        }

        private static void WriteManifest(LoadedMod mod)
        {
            try
            {
                var json = JsonUtility.ToJson(mod.Manifest, prettyPrint: true);
                File.WriteAllText(mod.ManifestPath, json);
            }
            catch (Exception ex) { ModHost.LogLine($"failed to write {mod.ManifestPath}: {ex.Message}"); }
        }

        // ----- LoadedMod ----------------------------------------------------

        internal sealed class LoadedMod
        {
            public ModManifest    Manifest;
            public string         ManifestPath;
            public string         Directory;
            public IMod           Instance;
            public IModLifecycle  Lifecycle;
            public ModContext     Context;
            public Assembly       Assembly;
            public bool           IsActive;
        }
    }
}
