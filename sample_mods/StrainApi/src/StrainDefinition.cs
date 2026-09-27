using System;
using System.Collections.Generic;

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

        /// <summary>Display name, shown in the MOD STRAINS picker and the console.</summary>
        public string Name { get; internal set; }

        /// <summary>
        /// What the strain does, one or two sentences. The console and the picker show it
        /// as plain text, so markup such as <c>&lt;color=©&gt;</c> is stripped there.
        /// </summary>
        public string Description { get; internal set; } = "";

        /// <summary>The assembly that built the strain, for diagnostics (<c>strain info</c>).</summary>
        public string Source { get; }

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

        // Delegate hooks from the builder. They run after the behaviour's own override of
        // the same hook, so a strain can use either style or both.
        internal Action<StrainBehaviour> Activated;
        internal Action<StrainBehaviour> RunStarted;
        internal Action<StrainBehaviour> GameStarted;
        internal Action<StrainBehaviour> PlayerTurn;
        internal Action<StrainBehaviour> GameEnded;
        internal Action<StrainBehaviour> ShopOpened;
        internal Action<StrainBehaviour> Deactivated;

        internal StrainDefinition(string id, string source)
        {
            Id = id;
            Name = id;
            Source = string.IsNullOrEmpty(source) ? "unknown" : source;
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
