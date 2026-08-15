namespace Gambonanza.BetterCollection.Search
{
    /// <summary>
    /// Scores how well a candidate string matches a query. Higher is better,
    /// <see cref="NoMatch"/> means it does not match at all.
    ///
    /// Ranking is tiered rather than a single distance metric so the obvious answer
    /// always wins: typing "kn" should put "Knight" above "Broken Crown", even though
    /// both contain the letters. Within a tier, shorter candidates win - they are the
    /// more specific answer.
    /// </summary>
    public static class FuzzyMatch
    {
        public const int NoMatch = -1;

        private const int ExactTier = 10000;
        private const int PrefixTier = 8000;
        private const int WordPrefixTier = 6000;
        private const int ContainsTier = 4000;
        private const int SubsequenceTier = 2000;

        /// <summary>
        /// <paramref name="candidateLower"/> must already be lower-cased; the caller
        /// indexes once instead of re-lowering every gambit on every keystroke.
        /// </summary>
        public static int Score(string candidateLower, string queryLower)
        {
            if (string.IsNullOrEmpty(queryLower)) return 0;
            if (string.IsNullOrEmpty(candidateLower)) return NoMatch;

            if (candidateLower == queryLower) return ExactTier;

            if (candidateLower.StartsWith(queryLower)) return PrefixTier - candidateLower.Length;

            int wordStart = WordPrefixIndex(candidateLower, queryLower);
            if (wordStart >= 0) return WordPrefixTier - wordStart - candidateLower.Length;

            int idx = candidateLower.IndexOf(queryLower, System.StringComparison.Ordinal);
            if (idx >= 0) return ContainsTier - idx - candidateLower.Length;

            int gaps = SubsequenceGaps(candidateLower, queryLower);
            if (gaps >= 0) return SubsequenceTier - gaps - candidateLower.Length;

            return NoMatch;
        }

        /// <summary>Index of a word boundary where the query starts a word, else -1.</summary>
        private static int WordPrefixIndex(string candidate, string query)
        {
            for (int i = 1; i < candidate.Length; i++)
            {
                if (!IsBoundary(candidate[i - 1])) continue;
                if (i + query.Length > candidate.Length) break;
                bool ok = true;
                for (int j = 0; j < query.Length; j++)
                {
                    if (candidate[i + j] != query[j]) { ok = false; break; }
                }
                if (ok) return i;
            }
            return -1;
        }

        private static bool IsBoundary(char c) => c == ' ' || c == '-' || c == '_' || c == '\'';

        /// <summary>
        /// Total skipped characters if every query char appears in order, else -1.
        /// This is what makes "gldidl" find "Golden Idol".
        /// </summary>
        private static int SubsequenceGaps(string candidate, string query)
        {
            int ci = 0, gaps = 0;
            for (int qi = 0; qi < query.Length; qi++)
            {
                char want = query[qi];
                int start = ci;
                while (ci < candidate.Length && candidate[ci] != want) ci++;
                if (ci >= candidate.Length) return -1;
                gaps += ci - start;
                ci++;
            }
            return gaps;
        }
    }
}
