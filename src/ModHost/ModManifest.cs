using System;
using UnityEngine;

namespace Gambonanza.ModHost
{
    /// <summary>
    /// Wire format of mod.json. Flat by design so Unity's JsonUtility can deserialize it.
    /// Public fields, not properties - JsonUtility ignores properties.
    /// </summary>
    [Serializable]
    public class ModManifest
    {
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
                var m = JsonUtility.FromJson<ModManifest>(json);
                if (m == null) { error = "empty or invalid JSON"; return null; }
                error = null;
                return m;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return null;
            }
        }
    }

    [Serializable]
    public class ModKeybindManifest
    {
        public string name;
        public string description;
        public string key;
    }
}
