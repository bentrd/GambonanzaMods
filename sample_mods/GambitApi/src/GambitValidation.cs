using System.Collections.Generic;
using System.Linq;
using Blukulele.CHE;
using UnityEngine;

namespace Gambonanza.GambitApi
{
    /// <summary>
    /// Guards against Rarity / Gambit_Focus values that vanilla
    /// <c>GambitLibrary.Initialize()</c> does not handle.
    ///
    /// Initialize() switches over both enums and closes each switch with
    /// <c>default: throw new ArgumentOutOfRangeException()</c>, but the enums carry
    /// members those switches skip: <c>Rarity.STRAIN</c> and <c>Gambit_Focus.NONE</c>.
    /// NONE is a sentinel rather than a real category - vanilla's own focus-count
    /// helper handles it with <c>Debug.LogError("SHOULD NOT HAPPEN")</c>.
    ///
    /// The blast radius is the whole library, not just the offending card: Initialize()
    /// walks every entry in GambitsInfo, so one gambit carrying an unhandled value makes
    /// it throw for every mod registered afterwards too. Substitute a safe value and tell
    /// the modder instead.
    /// </summary>
    internal static class GambitValidation
    {
        // Mirrors exactly the cases vanilla GambitLibrary.Initialize() handles.
        private static readonly HashSet<Rarity> SupportedRarities = new()
        {
            Rarity.COMMON, Rarity.RARE, Rarity.EPIC, Rarity.LEGENDARY,
        };

        private static readonly HashSet<Gambit_Focus> SupportedFocuses = new()
        {
            Gambit_Focus.PAWN, Gambit_Focus.ROOK, Gambit_Focus.KNIGHT, Gambit_Focus.BISHOP,
            Gambit_Focus.QUEEN, Gambit_Focus.KING, Gambit_Focus.MONEY, Gambit_Focus.UTILITY,
            Gambit_Focus.PROMOTION, Gambit_Focus.WAIT, Gambit_Focus.GOLDEN, Gambit_Focus.BLESS,
            Gambit_Focus.PROTECTIVE, Gambit_Focus.TRAP, Gambit_Focus.PHANTOM, Gambit_Focus.LANDING,
            Gambit_Focus.SACRIFICE, Gambit_Focus.PIECE_SELLER, Gambit_Focus.GAMBIT_SELLER,
            Gambit_Focus.CRUMBLE,
        };

        public const Rarity FallbackRarity = Rarity.COMMON;
        public const Gambit_Focus FallbackFocus = Gambit_Focus.UTILITY;

        public static bool IsSupported(Rarity rarity) => SupportedRarities.Contains(rarity);

        public static bool IsSupported(Gambit_Focus focus) => SupportedFocuses.Contains(focus);

        /// <summary>
        /// Returns <paramref name="rarity"/> when the game can sort it, otherwise COMMON.
        /// <paramref name="who"/> identifies the gambit (or builder call) in the log line.
        /// </summary>
        public static Rarity SanitizeRarity(Rarity rarity, string who)
        {
            if (IsSupported(rarity)) return rarity;

            Debug.LogWarning(
                $"[GambitApi] {who}: Rarity.{rarity} is not one of the four shop rarities " +
                $"(COMMON/RARE/EPIC/LEGENDARY) and makes the game's GambitLibrary.Initialize() " +
                $"throw for the entire library. Using Rarity.{FallbackRarity} instead.");
            return FallbackRarity;
        }

        /// <summary>
        /// Drops any focus the game cannot sort. Falls back to a single UTILITY entry when
        /// nothing usable is left (or nothing was supplied at all).
        /// </summary>
        public static Gambit_Focus[] SanitizeFocus(Gambit_Focus[] focus, string who)
        {
            if (focus == null || focus.Length == 0)
                return new[] { FallbackFocus };

            var rejected = focus.Where(f => !IsSupported(f)).Distinct().ToArray();
            if (rejected.Length == 0) return focus;

            var kept = focus.Where(IsSupported).ToArray();
            string names = string.Join(", ", rejected.Select(f => $"Gambit_Focus.{f}"));

            if (kept.Length == 0)
            {
                Debug.LogWarning(
                    $"[GambitApi] {who}: {names} is not a focus the game can sort - it makes " +
                    $"GambitLibrary.Initialize() throw for the entire library. Using " +
                    $"Gambit_Focus.{FallbackFocus} instead; pass a real focus to control shop weighting.");
                return new[] { FallbackFocus };
            }

            Debug.LogWarning(
                $"[GambitApi] {who}: dropped {names} - not a focus the game can sort " +
                $"(it makes GambitLibrary.Initialize() throw for the entire library). " +
                $"Keeping the remaining {kept.Length} focus value(s).");
            return kept;
        }
    }
}
