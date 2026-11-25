using System;
using System.Collections.Generic;
using System.Linq;

namespace Gambonanza.ModHost
{
    /// <summary>
    /// Wire format of mod.json. Keep the original fields so a rebind or toggle also
    /// preserves metadata owned by the mod or the manager.
    /// </summary>
    [Serializable]
    public class ModManifest
    {
        private Dictionary<string, object> _fields;

        public string id;
        public string name;
        public string version;
        public string author;
        /// <summary>Fully qualified IMod entry type, e.g. "Gambonanza.EnemyThreatOverlay.EnemyThreatOverlayMod".</summary>
        public string entry;
        /// <summary>If false, ModHost skips this mod entirely.</summary>
        public bool enabled = true;
        /// <summary>Optional. Currently informational; future use for compatibility checks.</summary>
        public string gameVersion;
        /// <summary>
        /// Optional. IDs of other mods that must be loaded before this one. ModHost will
        /// topologically sort discovered mods so dependencies' OnLoad runs first. Missing
        /// dependencies log a warning but do not block load (the mod is loaded last).
        /// </summary>
        public string[] dependencies;
        /// <summary>
        /// Optional keybind metadata. If omitted, ModHost exposes a default
        /// "toggle" bind in the console with key "unset".
        /// </summary>
        public ModKeybindManifest[] keybinds;

        public bool IsValid(out string error)
        {
            if (string.IsNullOrWhiteSpace(id))    { error = "missing 'id'";    return false; }
            if (string.IsNullOrWhiteSpace(entry)) { error = "missing 'entry'"; return false; }
            error = null;
            return true;
        }

        public static ModManifest TryParse(string json, out string error)
        {
            try
            {
                var fields = TinyJson.AsObject(TinyJson.Parse(json, preserveNumberText: true));
                if (fields == null) { error = "the manifest must be a JSON object"; return null; }

                var manifest = new ModManifest
                {
                    _fields = fields,
                    id = ReadString(fields, "id"),
                    name = ReadString(fields, "name"),
                    version = ReadString(fields, "version"),
                    author = ReadString(fields, "author"),
                    entry = ReadString(fields, "entry"),
                    enabled = !(fields.TryGetValue("enabled", out var rawEnabled) && rawEnabled is false),
                    gameVersion = ReadString(fields, "gameVersion"),
                };

                if (fields.TryGetValue("dependencies", out var rawDependencies) && rawDependencies is List<object> dependencies)
                    manifest.dependencies = dependencies.OfType<string>().ToArray();
                if (fields.TryGetValue("keybinds", out var rawKeybinds) && rawKeybinds is List<object> keybinds)
                    manifest.keybinds = keybinds.OfType<Dictionary<string, object>>().Select(ModKeybindManifest.FromFields).ToArray();

                error = null;
                return manifest;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return null;
            }
        }

        internal string ToJson()
        {
            var fields = _fields == null ? new Dictionary<string, object>() : new Dictionary<string, object>(_fields);
            WriteField(fields, "id", id);
            WriteField(fields, "name", name);
            WriteField(fields, "version", version);
            WriteField(fields, "author", author);
            WriteField(fields, "entry", entry);
            fields["enabled"] = enabled;
            WriteField(fields, "gameVersion", gameVersion);
            WriteField(fields, "dependencies", dependencies?.Cast<object>().ToList());
            WriteField(fields, "keybinds", keybinds?.Select(binding => (object)binding?.ToFields()).ToList());
            return TinyJson.Serialize(fields);
        }

        internal static string ReadString(Dictionary<string, object> fields, string name)
            => fields.TryGetValue(name, out var value) ? value as string : null;

        internal static void WriteField(Dictionary<string, object> fields, string name, object value)
        {
            if (value != null || fields.ContainsKey(name)) fields[name] = value;
        }
    }

    [Serializable]
    public class ModKeybindManifest
    {
        private Dictionary<string, object> _fields;

        public string name;
        public string description;
        public string key;

        internal static ModKeybindManifest FromFields(Dictionary<string, object> fields)
            => new ModKeybindManifest
            {
                _fields = fields,
                name = ModManifest.ReadString(fields, "name"),
                description = ModManifest.ReadString(fields, "description"),
                key = ModManifest.ReadString(fields, "key"),
            };

        internal Dictionary<string, object> ToFields()
        {
            var fields = _fields == null ? new Dictionary<string, object>() : new Dictionary<string, object>(_fields);
            ModManifest.WriteField(fields, "name", name);
            ModManifest.WriteField(fields, "description", description);
            ModManifest.WriteField(fields, "key", key);
            return fields;
        }
    }
}
