using System;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using UnityEngine;

namespace Gambonanza.StrainApi
{
    /// <summary>
    /// Fluent builder for custom strains. Only <see cref="Create"/> (first) and
    /// <see cref="Register"/> (last) are required; the rest can come in any order.
    ///
    /// <code>
    /// StrainBuilder.Create("taxman")
    ///     .WithName("Taxman")
    ///     .WithDescription("Every game costs <color=*>$1</color> to start.")
    ///     .WithHeat(1)
    ///     .WithIconFile("taxman.png")
    ///     .OnGameStart(strain => ChargeOneDollar())
    ///     .Register();
    /// </code>
    ///
    /// A strain does its work either through the delegate hooks here (quick, stateless)
    /// or through a <see cref="StrainBehaviour"/> subclass passed to
    /// <see cref="WithBehaviour{T}"/> (stateful: fields, Update, coroutines). Both can be
    /// combined; the behaviour's override runs before the delegate of the same hook.
    /// </summary>
    public sealed class StrainBuilder
    {
        private readonly StrainDefinition _def;

        private StrainBuilder(string id, Assembly caller)
        {
            string directory = null;
            try { directory = Path.GetDirectoryName(caller.Location); } catch { }
            _def = new StrainDefinition(id?.Trim(), caller.GetName().Name, directory);
        }

        /// <summary>
        /// Start a strain with the given id: lowercase letters, digits, '-' and '_',
        /// up to <see cref="Strains.MaxIdLength"/> characters. Keep it short and never
        /// change it - the player's saved choices and saved runs refer to it.
        /// </summary>
        [MethodImpl(MethodImplOptions.NoInlining)]
        public static StrainBuilder Create(string id)
            => new StrainBuilder(id, Assembly.GetCallingAssembly());

        /// <summary>Display name. Defaults to the id.</summary>
        public StrainBuilder WithName(string name)
        {
            if (!string.IsNullOrWhiteSpace(name)) _def.Name = name.Trim();
            return this;
        }

        /// <summary>What the strain does, in the game's voice ("Every price is increased by 20%.").</summary>
        public StrainBuilder WithDescription(string description)
        {
            _def.Description = description?.Trim() ?? "";
            return this;
        }

        /// <summary>
        /// What the strain adds to the heat gauge when picked, like the game's own strains
        /// (1 for a nuisance, 2 for a real handicap, 3 for a brutal one). 0 to
        /// <see cref="Strains.MaxHeat"/>; defaults to 1. Bonuses always have zero heat.
        /// </summary>
        public StrainBuilder WithHeat(int heat)
        {
            _def.Heat = _def.IsBonus ? 0 : Mathf.Clamp(heat, 0, Strains.MaxHeat);
            return this;
        }

        /// <summary>
        /// Make this a helpful bonus, displayed in the bonus column on modded Custom
        /// pages. Its heat is zero, regardless of the order of WithHeat calls.
        /// </summary>
        public StrainBuilder AsBonus()
        {
            _def.IsBonus = true;
            _def.Heat = 0;
            return this;
        }

        /// <summary>The icon on the strain's card. Pixel art the size of the game's own (33x27) fits best.</summary>
        public StrainBuilder WithIcon(Sprite icon)
        {
            _def.Icon = icon;
            return this;
        }

        /// <summary>
        /// The icon on the strain's card, from a PNG shipped in your mod's folder (the path
        /// is relative to it): <c>.WithIconFile("taxman.png")</c>. Loaded with point
        /// filtering, like the game's pixel art; the game's own strain icons are 33x27.
        /// </summary>
        public StrainBuilder WithIconFile(string relativePath)
        {
            _def.IconFile = string.IsNullOrWhiteSpace(relativePath) ? null : relativePath.Trim();
            return this;
        }

        /// <summary>The icon on the strain's card, borrowed from one of the game's sprites by name ("SPR_Ascend_Lock").</summary>
        public StrainBuilder WithGameIcon(string spriteName)
        {
            _def.GameIconName = string.IsNullOrWhiteSpace(spriteName) ? null : spriteName.Trim();
            return this;
        }

        /// <summary>
        /// Strains that cannot be on a run together with this one. Choosing one of them for
        /// the next run deselects the others. Unknown ids are fine (the other mod may not
        /// be installed); the rule applies once both are registered.
        /// </summary>
        public StrainBuilder IncompatibleWith(params string[] strainIds)
        {
            if (strainIds == null) return this;
            foreach (var raw in strainIds)
            {
                var id = raw?.Trim();
                if (string.IsNullOrEmpty(id) || id == _def.Id || _def._incompatibleWith.Contains(id)) continue;
                _def._incompatibleWith.Add(id);
            }
            return this;
        }

        /// <summary>
        /// Run <typeparamref name="T"/> while the strain is on the run being played. See
        /// <see cref="StrainBehaviour"/> for its lifetime.
        /// </summary>
        public StrainBuilder WithBehaviour<T>() where T : StrainBehaviour
        {
            _def.BehaviourType = typeof(T);
            return this;
        }

        /// <summary>
        /// The strain came alive on the run being played: a new run started with it, or a
        /// saved run with it was continued. The place to subscribe to game events or take
        /// handles; undo them in <see cref="OnDeactivate"/>.
        /// </summary>
        public StrainBuilder OnActivate(Action<StrainBehaviour> hook) { _def.Activated += hook; return this; }

        /// <summary>A new run started with the strain on it. Once per run, not on continue.</summary>
        public StrainBuilder OnRunStart(Action<StrainBehaviour> hook) { _def.RunStarted += hook; return this; }

        /// <summary>A game (one match against the opponent) began. Once per game: not again when a run is continued mid-game.</summary>
        public StrainBuilder OnGameStart(Action<StrainBehaviour> hook) { _def.GameStarted += hook; return this; }

        /// <summary>The start of each of the player's turns during a game.</summary>
        public StrainBuilder OnPlayerTurn(Action<StrainBehaviour> hook) { _def.PlayerTurn += hook; return this; }

        /// <summary>A game is over: won, or left in the middle.</summary>
        public StrainBuilder OnGameEnd(Action<StrainBehaviour> hook) { _def.GameEnded += hook; return this; }

        /// <summary>The shop opened after a game (not when a run is continued in the shop).</summary>
        public StrainBuilder OnShopOpen(Action<StrainBehaviour> hook) { _def.ShopOpened += hook; return this; }

        /// <summary>
        /// The strain is being put away: the player left the run (to the menu, or because
        /// it ended), the strain was taken off the run, or StrainApi was disabled. Undo
        /// whatever <see cref="OnActivate"/> set up.
        /// </summary>
        public StrainBuilder OnDeactivate(Action<StrainBehaviour> hook) { _def.Deactivated += hook; return this; }

        /// <summary>The definition, without registering it. For tests and for registering later.</summary>
        public StrainDefinition Build() => _def;

        /// <summary>
        /// Build the definition and register it. Returns null if it was rejected (bad or
        /// duplicate id, abstract behaviour type); the log says why. Safe to call from
        /// <c>OnLoad</c>: strains need nothing from the game to be registered.
        /// </summary>
        public StrainDefinition Register() => StrainRegistry.Register(_def) ? _def : null;
    }
}
