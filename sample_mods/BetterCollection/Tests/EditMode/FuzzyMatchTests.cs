using System.Collections.Generic;
using System.Linq;
using Gambonanza.BetterCollection.Search;
using NUnit.Framework;

namespace Gambonanza.BetterCollection.Tests
{
    /// <summary>
    /// The search bar is only as good as its ranking, and ranking bugs are invisible
    /// in play - a slightly wrong order just looks like "search is a bit rubbish".
    /// These pin the tiers down.
    /// </summary>
    public sealed class FuzzyMatchTests
    {
        private static readonly string[] Gambits =
        {
            "Knight", "Brave Knight", "Broken Crown", "Golden Idol", "Axe", "Axe Throw",
            "Trap", "Trampoline", "The ROOOOOK", "Lucky Coin", "King of Winter",
        };

        /// <summary>Ranks names the way GambitIndex does: score desc, then library order.</summary>
        private static List<string> Rank(string query)
        {
            return Gambits
                .Select((n, i) => new { n, i, s = FuzzyMatch.Score(n.ToLowerInvariant(), query.ToLowerInvariant()) })
                .Where(x => x.s != FuzzyMatch.NoMatch)
                .OrderByDescending(x => x.s).ThenBy(x => x.i)
                .Select(x => x.n)
                .ToList();
        }

        [Test]
        public void PrefixBeatsEveryWeakerTier()
        {
            var r = Rank("kn");
            Assert.AreEqual("Knight", r[0]);
            Assert.Less(r.IndexOf("Brave Knight"), r.IndexOf("Broken Crown"),
                "a word-prefix match must outrank a scattered subsequence match");
        }

        [Test]
        public void ShorterCandidateWinsWithinATier()
        {
            var r = Rank("ax");
            Assert.AreEqual("Axe", r[0], "the more specific answer should come first");
            Assert.Contains("Axe Throw", r);
        }

        [Test]
        public void ExactMatchOutranksAPrefixOfALongerName()
        {
            var r = Rank("trap");
            Assert.AreEqual("Trap", r[0]);
            Assert.Contains("Trampoline", r);
        }

        [Test]
        public void SubsequenceMatchingFindsInitials()
        {
            Assert.Contains("Golden Idol", Rank("gldidl"));
        }

        [Test]
        public void MatchesWordsInTheMiddleOfAName()
        {
            Assert.AreEqual("King of Winter", Rank("winter")[0]);
        }

        [Test]
        public void NonMatchesAndEdgeCases()
        {
            Assert.AreEqual(FuzzyMatch.NoMatch, FuzzyMatch.Score("knight", "zzzz"));
            Assert.AreEqual(FuzzyMatch.NoMatch, FuzzyMatch.Score("", "kn"));
            Assert.AreEqual(0, FuzzyMatch.Score("knight", ""), "an empty query matches everything neutrally");
        }
    }
}
