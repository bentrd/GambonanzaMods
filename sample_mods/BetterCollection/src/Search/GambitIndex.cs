using System.Collections.Generic;
using Blukulele.CHE;
using Blukulele.Core;

namespace Gambonanza.BetterCollection.Search
{
    /// <summary>
    /// Lower-cased, localized search index over the gambits currently in the
    /// collection. Built once per screen open (language and unlock state can both
    /// change between opens) so keystrokes only ever do comparisons.
    /// </summary>
    public sealed class GambitIndex
    {
        public struct Entry
        {
            public SO_Gambit Gambit;
            public string DisplayName;   // localized, shown in the suggestion list
            public string NameLower;
            public string DescriptionLower;
            public string IdLower;
            public bool Unlocked;
        }

        private readonly List<Entry> _entries = new List<Entry>();
        public IReadOnlyList<Entry> Entries => _entries;
        public int Count => _entries.Count;

        public void Build(IEnumerable<SO_Gambit> gambits)
        {
            _entries.Clear();
            JSONNode gambitText = null;
            try
            {
                gambitText = SingletonMonoBehaviour<LocalizationManager>.Instance?.GetTraduction()?["gambit"];
            }
            catch { /* fall back to raw keys below */ }

            GambitUnlockManager unlocks = null;
            try { unlocks = SingletonMonoBehaviour<GambitUnlockManager>.Instance; } catch { }

            foreach (var g in gambits)
            {
                if (g == null) continue;

                string name = null, desc = null;
                if (gambitText != null)
                {
                    name = gambitText[g.GambitName]?.Value;
                    desc = gambitText[g.GambitDescription]?.Value;
                }
                // Locked gambits still get indexed by their real name: hiding them from
                // search would make the filter lie about what the page contains.
                if (string.IsNullOrEmpty(name)) name = g.GambitName ?? g.ID ?? "";

                _entries.Add(new Entry
                {
                    Gambit = g,
                    DisplayName = name,
                    NameLower = name.ToLowerInvariant(),
                    DescriptionLower = (desc ?? "").ToLowerInvariant(),
                    IdLower = (g.ID ?? "").ToLowerInvariant(),
                    Unlocked = unlocks != null && !string.IsNullOrEmpty(g.ID) && unlocks.IsUnlocked(g.ID),
                });
            }
        }

        private struct Scored
        {
            public int Score;
            public int Order;      // original library order, for a stable tie-break
            public Entry Entry;
        }

        /// <summary>
        /// Gambits matching <paramref name="query"/>, best first. An empty query
        /// returns everything in library order.
        /// </summary>
        public List<Entry> Search(string query)
        {
            var results = new List<Entry>();
            if (string.IsNullOrEmpty(query))
            {
                for (int i = 0; i < _entries.Count; i++) results.Add(_entries[i]);
                return results;
            }

            string q = query.Trim().ToLowerInvariant();
            var scored = new List<Scored>();
            for (int i = 0; i < _entries.Count; i++)
            {
                var e = _entries[i];
                int best = FuzzyMatch.Score(e.NameLower, q);

                // The id is how the console refers to gambits, so "give gambit lich"
                // and searching "lich" should agree even if the display name differs.
                int byId = FuzzyMatch.Score(e.IdLower, q);
                if (byId != FuzzyMatch.NoMatch && byId > best) best = byId;

                // Description matches are real but always weaker than a name match,
                // so "trap" ranks the Trap gambit above everything that mentions traps.
                int byDesc = FuzzyMatch.Score(e.DescriptionLower, q);
                if (byDesc != FuzzyMatch.NoMatch)
                {
                    int weakened = byDesc / 4;
                    if (weakened > best) best = weakened;
                }

                if (best == FuzzyMatch.NoMatch) continue;
                scored.Add(new Scored { Score = best, Order = i, Entry = e });
            }

            scored.Sort((a, b) => a.Score != b.Score ? b.Score.CompareTo(a.Score) : a.Order.CompareTo(b.Order));
            for (int i = 0; i < scored.Count; i++) results.Add(scored[i].Entry);
            return results;
        }
    }
}
