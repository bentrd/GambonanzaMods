using System;
using System.Collections.Generic;
using UnityEngine;

namespace Gambonanza.StrainApi
{
    /// <summary>
    /// Everything the API knows about one strain. Built with <see cref="StrainBuilder"/>
    /// and read back with <see cref="Strains.Get"/>. Read-only once built: to change a
    /// strain, <see cref="Strains.Unregister"/> it and register a new definition.
    /// </summary>
    public sealed class StrainDefinition
    {
        /// <summary>
        /// Unique, permanent id: the console (<c>strain on &lt;id&gt;</c>), the player's
        /// saved selection and the saved run all refer to the strain by it.
        /// </summary>
        public string Id { get; }

        /// <summary>Display name, shown on the strain's card on the Custom strain screen and in the console.</summary>
        public string Name { get; internal set; }

        /// <summary>
        /// What the strain does, one or two sentences, in the game's own markup: the card's
        /// tooltip runs it through the game's text rewriting (so <c>&lt;color=*&gt;</c> is
        /// its money colour), and the console shows it with the markup stripped.
        /// </summary>
        public string Description { get; internal set; } = "";

        /// <summary>The assembly that built the strain, for diagnostics (<c>strain info</c>).</summary>
        public string Source { get; }

        /// <summary>
        /// What the strain adds to the heat gauge on the Custom strain screen, like the
        /// cost of the game's own strains (1 to 3). Picked strains count toward the
        /// gauge, its markers and the run's heat, which can go past the gauge's 30.
        /// </summary>
        public int Heat { get; internal set; } = 1;

        /// <summary>
        /// The icon on the strain's card, if one was given as a sprite. Icons given as a
        /// file or a game sprite name are loaded when the card is first shown.
        /// </summary>
        public Sprite Icon { get; internal set; }

        /// <summary>
        /// Ids of strains this one cannot be combined with. Selecting either side for the
        /// next run deselects the other. Declaring it on one side is enough.
        /// </summary>
        public IReadOnlyList<string> IncompatibleWith => _incompatibleWith;

        /// <summary>
        /// The <see cref="StrainBehaviour"/> subclass spawned while the strain is on a run
        /// in progress, or null when the strain only uses the builder's delegate hooks.
        /// </summary>
        public Type BehaviourType { get; internal set; }

        internal readonly List<string> _incompatibleWith = new List<string>();

        /// <summary>The folder of the mod that built the strain: WithIconFile paths are relative to it.</summary>
        internal string SourceDirectory;
        internal string IconFile;
        internal string GameIconName;

        // Delegate hooks from the builder. They run after the behaviour's own override of
        // the same hook, so a strain can use either style or both.
        internal Action<StrainBehaviour> Activated;
        internal Action<StrainBehaviour> RunStarted;
        internal Action<StrainBehaviour> GameStarted;
        internal Action<StrainBehaviour> PlayerTurn;
        internal Action<StrainBehaviour> GameEnded;
        internal Action<StrainBehaviour> ShopOpened;
        internal Action<StrainBehaviour> Deactivated;

        internal StrainDefinition(string id, string source, string sourceDirectory = null)
        {
            Id = id;
            Name = id;
            Source = string.IsNullOrEmpty(source) ? "unknown" : source;
            SourceDirectory = sourceDirectory;
        }

        /// <summary>True when either definition declares the other incompatible.</summary>
        public bool ConflictsWith(StrainDefinition other)
        {
            if (other == null || ReferenceEquals(other, this)) return false;
            return _incompatibleWith.Contains(other.Id) || other._incompatibleWith.Contains(Id);
        }

        public override string ToString() => $"{Name} ({Id})";
    }
}
