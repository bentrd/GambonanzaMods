using System;
using Blukulele.CHE;
using UnityEngine;

namespace Gambonanza.GambitApi
{
    /// <summary>
    /// Holds all configuration data needed to create and register a custom gambit.
    /// </summary>
    public class GambitDefinition
    {
        public string Id;
        public string Name = "New Gambit";
        public string Description = "A custom gambit.";
        public Sprite Visual;
        public int PriceCost = 5;
        public Rarity Rarity = Rarity.COMMON;
        public Gambit_Focus[] Focus = new[] { Gambit_Focus.UTILITY };
        public Unlock_Infos UnlockInfo = Unlock_Infos.NONE;
        public int GambitToUnlockToHaveAHint;

        // UI explanation flags. Each true value adds vanilla's matching keyword-explainer
        // box (localized title + one-line rule, quoted below in English) to the card's
        // tooltip in the shop, the collection and in-run. Display-only - no gameplay
        // effect. Convention: enable one for every keyword the Description uses, and no
        // others. Full table incl. the pairing with <color>/<sprite> description markup:
        // wiki -> API Reference -> "UI explanation flags".

        /// <summary>PROMOTION - "Transform a PAWN into another piece when it reaches the end of the board."</summary>
        public bool ShowPromotion;
        /// <summary>BLESSED PIECE - "Once captured, return to your stock."</summary>
        public bool ShowBless;
        /// <summary>GOLDEN PIECE - "Give +$2 at the end of the game and reset to DEFAULT piece."</summary>
        public bool ShowGolden;
        /// <summary>PROTECTED PIECE - "Can't be captured."</summary>
        public bool ShowProtect;
        /// <summary>TRAPPED PIECE - "Can't move."</summary>
        public bool ShowTrap;
        /// <summary>PHANTOM PIECE - "Sell for $0 and disappear at the end of a game."</summary>
        public bool ShowPhantom;
        /// <summary>WAIT - "Skip your turn without playing."</summary>
        public bool ShowWait;
        /// <summary>GOLDEN TILE - "Moving a piece on this tile turns it into a GOLDEN PIECE."</summary>
        public bool ShowGoldenTile;
        /// <summary>BLESS TILE - "Moving a piece on this tile BLESSES it."</summary>
        public bool ShowBlessedTile;
        /// <summary>PROTECT TILE - "Moving a piece on this tile PROTECTS it."</summary>
        public bool ShowProtectedTile;
        /// <summary>TRAP TILE - "When an enemy piece steps on this tile, TRAPS it."</summary>
        public bool ShowTrapTile;
        /// <summary>PHANTOM TILE - "Moving a piece on this tile grants a PHANTOM copy of it."</summary>
        public bool ShowPhantomTile;
        /// <summary>LANDING - "Placing a piece from stock to board during a game."</summary>
        public bool ShowLanding;
        /// <summary>COUNTED AS - "For Gambit effects only, this piece is treated as the specified piece. (This piece keeps its normal movement)."</summary>
        public bool ShowConsideredAs;

        /// <summary>
        /// ID of the vanilla gambit to clone the prefab from (e.g. "COWBOY").
        /// If null, the API will attempt to find any available gambit prefab.
        /// </summary>
        public string TemplateGambitId;

        /// <summary>
        /// The concrete BaseGambit type to attach to the prefab.
        /// Defaults to SimpleGambit when using OnTrigger.
        /// </summary>
        public Type BaseGambitType;

        /// <summary>
        /// Trigger action used by SimpleGambit.
        /// </summary>
        public Action<GambitBehaviour> TriggerAction;

        /// <summary>
        /// Whether to auto-unlock this gambit so it appears in the shop.
        /// </summary>
        public bool AutoUnlock = true;

        /// <summary>
        /// On-board scale multiplier for the in-game sprite. 1.0 matches the cloned vanilla
        /// template's world height exactly. Use a value below 1 to shrink (handy when your
        /// art is more tightly cropped than vanilla and ends up looking visually larger),
        /// or above 1 to grow. Only affects the in-world piece - collection art is untouched.
        /// </summary>
        public float VisualScale = 1f;
    }
}
