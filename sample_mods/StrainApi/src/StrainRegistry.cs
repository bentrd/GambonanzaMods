using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Gambonanza.StrainApi
{
    /// <summary>
    /// Every registered strain, in registration order. Registration only touches this
    /// list, never the game, so it works from any mod's OnLoad; one bad definition is
    /// rejected on its own and never stops the strains registered after it.
    /// </summary>
    internal static class StrainRegistry
    {
        private static readonly Regex IdPattern = new Regex("^[a-z0-9][a-z0-9_-]*$", RegexOptions.CultureInvariant);
        private static readonly Regex Markup = new Regex("<[^>]*>", RegexOptions.CultureInvariant);

        private static readonly List<StrainDefinition> _ordered = new List<StrainDefinition>();
        private static readonly Dictionary<string, StrainDefinition> _byId = new Dictionary<string, StrainDefinition>(StringComparer.Ordinal);

        internal static IReadOnlyList<StrainDefinition> All => _ordered.ToArray();
        internal static int Count => _ordered.Count;

        /// <summary>Bumped on every register and unregister, so the strain screen knows to rebuild its cards.</summary>
        internal static int Version { get; private set; }

        internal static StrainDefinition Get(string id)
            => id != null && _byId.TryGetValue(id, out var def) ? def : null;

        internal static bool Register(StrainDefinition def)
        {
            if (!IsValid(def, out var why))
            {
                StrainCore.Log($"rejected strain '{def?.Id}' from {def?.Source ?? "unknown"}: {why}");
                return false;
            }
            if (_byId.TryGetValue(def.Id, out var existing))
            {
                StrainCore.Log(ReferenceEquals(existing, def)
                    ? $"strain '{def.Id}' is already registered; ignored."
                    : $"rejected strain '{def.Id}' from {def.Source}: {existing.Source} already registered that id.");
                return false;
            }

            _ordered.Add(def);
            _byId.Add(def.Id, def);
            Version++;
            StrainCore.Log($"registered strain '{def.Id}' ({def.Name}) from {def.Source}.");
            StrainCore.OnRegistered(def);
            return true;
        }

        internal static bool Unregister(string id)
        {
            var def = Get(id);
            if (def == null) return false;
            StrainCore.OnUnregistering(def);
            _ordered.Remove(def);
            _byId.Remove(def.Id);
            Version++;
            StrainCore.Log($"unregistered strain '{def.Id}'.");
            return true;
        }

        /// <summary>
        /// Resolve what a player typed: an exact id, then an id or name ignoring case and
        /// spaces/dashes/underscores ("Heavy Snow", "heavy_snow" and "heavysnow" all find
        /// "heavy-snow").
        /// </summary>
        internal static StrainDefinition Find(string query)
        {
            if (string.IsNullOrWhiteSpace(query)) return null;
            var exact = Get(query.Trim());
            if (exact != null) return exact;
            var q = Loose(query);
            foreach (var def in _ordered)
                if (Loose(def.Id) == q || Loose(def.Name) == q) return def;
            return null;
        }

        /// <summary>Plain text for places that do not run the game's text markup (the console).</summary>
        internal static string PlainText(string text)
            => string.IsNullOrEmpty(text) ? "" : Markup.Replace(text, "").Replace("  ", " ").Trim();

        private static string Loose(string s)
            => (s ?? "").ToLowerInvariant().Replace(" ", "").Replace("-", "").Replace("_", "").Replace("'", "");

        private static bool IsValid(StrainDefinition def, out string why)
        {
            if (def == null) { why = "no definition"; return false; }
            if (string.IsNullOrEmpty(def.Id)) { why = "the id is empty"; return false; }
            if (def.Id.Length > Strains.MaxIdLength) { why = $"the id is longer than {Strains.MaxIdLength} characters"; return false; }
            if (!IdPattern.IsMatch(def.Id)) { why = "ids use lowercase letters, digits, '-' and '_' only (e.g. \"heavy-snow\")"; return false; }
            var t = def.BehaviourType;
            if (t != null && (t.IsAbstract || !typeof(StrainBehaviour).IsAssignableFrom(t)))
            {
                why = $"{t.Name} is abstract or not a StrainBehaviour";
                return false;
            }
            why = null;
            return true;
        }
    }
}
