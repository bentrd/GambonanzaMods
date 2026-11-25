using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Gambonanza.ModHost
{
    internal static class BundledModKeybinds
    {
        private const string ResourcePrefix = "Gambonanza.ModHost.BundledMods.";
        private static readonly Lazy<List<ModManifest>> Defaults = new Lazy<List<ModManifest>>(ReadDefaults);

        internal static void RestoreMissing(ModManifest manifest)
        {
            // Older framework versions could erase bindings when saving mod.json.
            // An explicit array, even an empty one, belongs to the installed mod.
            if (manifest.keybinds != null) return;

            var bundled = Defaults.Value.FirstOrDefault(candidate =>
                string.Equals(candidate.id, manifest.id, StringComparison.OrdinalIgnoreCase)
                && string.Equals(candidate.entry, manifest.entry, StringComparison.Ordinal)
                && IsSameOrOlderVersion(manifest.version, candidate.version));
            if (bundled == null) return;

            // The console can edit installed bindings without modifying the defaults.
            manifest.keybinds = bundled.keybinds.Where(bind => bind != null).Select(bind => new ModKeybindManifest
            {
                name = bind.name,
                description = bind.description,
                key = bind.key,
            }).ToArray();
        }

        private static bool IsSameOrOlderVersion(string installed, string bundled)
        {
            return string.Equals(installed, bundled, StringComparison.Ordinal)
                || (Version.TryParse(installed, out var installedVersion)
                    && Version.TryParse(bundled, out var bundledVersion)
                    && installedVersion <= bundledVersion);
        }

        private static List<ModManifest> ReadDefaults()
        {
            var defaults = new List<ModManifest>();
            var assembly = typeof(BundledModKeybinds).Assembly;
            foreach (var resource in assembly.GetManifestResourceNames())
            {
                if (!resource.StartsWith(ResourcePrefix, StringComparison.Ordinal)) continue;
                using var reader = new StreamReader(assembly.GetManifestResourceStream(resource));
                var manifest = ModManifest.TryParse(reader.ReadToEnd(), out _);
                if (manifest?.keybinds?.Length > 0 && manifest.IsValid(out _)) defaults.Add(manifest);
            }
            return defaults;
        }
    }
}
