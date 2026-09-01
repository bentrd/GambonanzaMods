using System;
using Blukulele.CHE;
using UnityEngine;

namespace Gambonanza.GambitApi
{
    /// <summary>
    /// Fluent builder for defining custom gambits.
    /// </summary>
    public class GambitBuilder
    {
        private readonly GambitDefinition _def;

        private GambitBuilder(string id)
        {
            _def = new GambitDefinition { Id = id };
        }

        /// <summary>
        /// Start building a new gambit with the given unique ID.
        /// </summary>
        public static GambitBuilder Create(string id) => new(id);

        /// <summary>
        /// Set the display name.
        /// </summary>
        public GambitBuilder WithName(string name)
        {
            _def.Name = name;
            return this;
        }

        /// <summary>
        /// Set the description shown in the tooltip.
        /// </summary>
        public GambitBuilder WithDescription(string description)
        {
            _def.Description = description;
            return this;
        }

        /// <summary>
        /// Set the shop/loot rarity. Must be COMMON, RARE, EPIC or LEGENDARY - anything
        /// else (Rarity.STRAIN) is rejected with a log line and replaced with COMMON,
        /// because the game cannot sort it and throws for the whole library if it tries.
        /// </summary>
        public GambitBuilder WithRarity(Rarity rarity)
        {
            _def.Rarity = GambitValidation.SanitizeRarity(rarity, Who());
            return this;
        }

        /// <summary>
        /// Set the gambit focus categories (affects shop weighting). Gambit_Focus.NONE is a
        /// sentinel, not a category: it is rejected with a log line and replaced with
        /// UTILITY, because the game cannot sort it and throws for the whole library if it tries.
        /// </summary>
        public GambitBuilder WithFocus(params Gambit_Focus[] focus)
        {
            _def.Focus = GambitValidation.SanitizeFocus(focus, Who());
            return this;
        }

        private string Who() =>
            string.IsNullOrWhiteSpace(_def.Id) ? "gambit builder" : $"gambit '{_def.Id}'";

        /// <summary>
        /// Set the shop price.
        /// </summary>
        public GambitBuilder WithPrice(int price)
        {
            _def.PriceCost = price;
            return this;
        }

        /// <summary>
        /// Set the card sprite.
        /// </summary>
        public GambitBuilder WithVisual(Sprite sprite)
        {
            _def.Visual = sprite;
            return this;
        }

        /// <summary>
        /// Multiplier applied to the on-board sprite's world height. 1.0 (default) matches
        /// the cloned vanilla template exactly. Drop below 1 if your art looks slightly
        /// large in-game (usually because it's more tightly cropped than vanilla cards).
        /// Collection art is unaffected.
        /// </summary>
        public GambitBuilder WithVisualScale(float scale)
        {
            _def.VisualScale = scale;
            return this;
        }

        /// <summary>
        /// Set the unlock requirement shown to the player.
        /// Use Unlock_Infos.NONE for no requirement.
        /// </summary>
        public GambitBuilder WithUnlockInfo(Unlock_Infos info)
        {
            _def.UnlockInfo = info;
            return this;
        }

        /// <summary>
        /// Set the ID of another gambit that must be unlocked before this one shows a hint.
        /// </summary>
        public GambitBuilder WithHintUnlockRequirement(int gambitId)
        {
            _def.GambitToUnlockToHaveAHint = gambitId;
            return this;
        }

        /// <summary>
        /// Clone the prefab from an existing vanilla gambit by its ID (e.g. "COWBOY", "BANNER").
        /// This copies all visuals, particles, colliders and UI setup.
        /// </summary>
        public GambitBuilder CloneFrom(string vanillaGambitId)
        {
            _def.TemplateGambitId = vanillaGambitId;
            return this;
        }

        /// <summary>
        /// Provide a simple trigger action. Automatically uses SimpleGambit as the runtime behaviour.
        /// </summary>
        public GambitBuilder OnTrigger(Action<GambitBehaviour> action)
        {
            _def.TriggerAction = action;
            _def.BaseGambitType = typeof(SimpleGambit);
            return this;
        }

        /// <summary>
        /// Use a custom BaseGambit subclass instead of SimpleGambit.
        /// The type must have a parameterless constructor and inherit from BaseGambit.
        /// </summary>
        public GambitBuilder WithBaseGambit<T>() where T : BaseGambit
        {
            _def.BaseGambitType = typeof(T);
            return this;
        }

        /// <summary>
        /// Whether to automatically unlock this gambit (default true).
        /// </summary>
        public GambitBuilder AutoUnlock(bool autoUnlock)
        {
            _def.AutoUnlock = autoUnlock;
            return this;
        }

        // --- UI explanation toggles ---
        //
        // Each Show* adds one of vanilla's keyword-explainer boxes (localized title +
        // one-line rule, quoted below in English) to the card's tooltip in the shop,
        // the collection and in-run. Display-only - no gameplay effect. All off by
        // default; convention is to enable one for every keyword the description uses,
        // and no others. Full table incl. the pairing with <color>/<sprite> description
        // markup: wiki -> API Reference -> "UI explanation flags".

        /// <summary>Explainer: PROMOTION - "Transform a PAWN into another piece when it reaches the end of the board."</summary>
        public GambitBuilder ShowPromotion() { _def.ShowPromotion = true; return this; }
        /// <summary>Explainer: BLESSED PIECE - "Once captured, return to your stock."</summary>
        public GambitBuilder ShowBless() { _def.ShowBless = true; return this; }
        /// <summary>Explainer: GOLDEN PIECE - "Give +$2 at the end of the game and reset to DEFAULT piece."</summary>
        public GambitBuilder ShowGolden() { _def.ShowGolden = true; return this; }
        /// <summary>Explainer: PROTECTED PIECE - "Can't be captured."</summary>
        public GambitBuilder ShowProtect() { _def.ShowProtect = true; return this; }
        /// <summary>Explainer: TRAPPED PIECE - "Can't move."</summary>
        public GambitBuilder ShowTrap() { _def.ShowTrap = true; return this; }
        /// <summary>Explainer: PHANTOM PIECE - "Sell for $0 and disappear at the end of a game."</summary>
        public GambitBuilder ShowPhantom() { _def.ShowPhantom = true; return this; }
        /// <summary>Explainer: WAIT - "Skip your turn without playing."</summary>
        public GambitBuilder ShowWait() { _def.ShowWait = true; return this; }
        /// <summary>Explainer: GOLDEN TILE - "Moving a piece on this tile turns it into a GOLDEN PIECE."</summary>
        public GambitBuilder ShowGoldenTile() { _def.ShowGoldenTile = true; return this; }
        /// <summary>Explainer: BLESS TILE - "Moving a piece on this tile BLESSES it."</summary>
        public GambitBuilder ShowBlessedTile() { _def.ShowBlessedTile = true; return this; }
        /// <summary>Explainer: PROTECT TILE - "Moving a piece on this tile PROTECTS it."</summary>
        public GambitBuilder ShowProtectedTile() { _def.ShowProtectedTile = true; return this; }
        /// <summary>Explainer: TRAP TILE - "When an enemy piece steps on this tile, TRAPS it."</summary>
        public GambitBuilder ShowTrapTile() { _def.ShowTrapTile = true; return this; }
        /// <summary>Explainer: PHANTOM TILE - "Moving a piece on this tile grants a PHANTOM copy of it."</summary>
        public GambitBuilder ShowPhantomTile() { _def.ShowPhantomTile = true; return this; }
        /// <summary>Explainer: LANDING - "Placing a piece from stock to board during a game."</summary>
        public GambitBuilder ShowLanding() { _def.ShowLanding = true; return this; }
        /// <summary>Explainer: COUNTED AS - "For Gambit effects only, this piece is treated as the specified piece. (This piece keeps its normal movement)."</summary>
        public GambitBuilder ShowConsideredAs() { _def.ShowConsideredAs = true; return this; }

        /// <summary>
        /// Build the definition without registering it yet.
        /// </summary>
        public GambitDefinition Build() => _def;

        /// <summary>
        /// Build the definition and immediately register it with the game.
        /// </summary>
        public GambitDefinition Register()
        {
            var def = Build();
            GambitRegistry.Register(def);
            return def;
        }
    }
}
