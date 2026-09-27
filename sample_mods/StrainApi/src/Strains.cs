using System;
using System.Collections.Generic;
using Blukulele.CHE;
using Blukulele.Core;

namespace Gambonanza.StrainApi
{
    /// <summary>
    /// Static entry point of the Strain Creation API. Reference Gambonanza.StrainApi.dll,
    /// list "StrainApi" under "dependencies" in your mod.json, build strains with
    /// <see cref="StrainBuilder"/>, and use this class to ask about them.
    ///
    /// A strain is a run modifier the player picks before a run, like the game's own
    /// strains. Modded strains live next to the vanilla ones rather than inside the
    /// game's strain screen: the player picks them from the MOD STRAINS button on the
    /// home screen (or <c>strain on &lt;id&gt;</c> in the console), and the picks are
    /// locked in when the next run starts. From then on the run keeps them - through
    /// quitting and continuing - until another run starts.
    ///
    /// Three words, used precisely:
    ///   registered - a loaded mod defined it this session.
    ///   selected   - the player picked it for their next run (a saved preference).
    ///   active     - it is on the run being played right now (its behaviour is alive).
    ///
    /// Everything here is safe to call at any time, including from OnLoad.
    /// </summary>
    public static class Strains
    {
        /// <summary>Longest id <see cref="StrainBuilder.Create"/> accepts.</summary>
        public const int MaxIdLength = 40;

        // ----- registry ------------------------------------------------------

        /// <summary>Every registered strain, in registration order.</summary>
        public static IReadOnlyList<StrainDefinition> All => StrainRegistry.All;

        /// <summary>The strain with this exact id, or null.</summary>
        public static StrainDefinition Get(string id) => StrainRegistry.Get(id);

        /// <summary>True if a loaded mod registered this id.</summary>
        public static bool IsRegistered(string id) => StrainRegistry.Get(id) != null;

        /// <summary>
        /// Register a definition made with <see cref="StrainBuilder.Build"/>. Same as
        /// <see cref="StrainBuilder.Register"/>; false when rejected (the log says why).
        /// </summary>
        public static bool Register(StrainDefinition definition) => StrainRegistry.Register(definition);

        /// <summary>
        /// Remove a strain, e.g. from your mod's <c>OnDisable</c>. If it is on the run
        /// being played it is put away first. The player's pick and the saved run keep
        /// the id, so registering it again brings everything back.
        /// </summary>
        public static bool Unregister(string id) => StrainRegistry.Unregister(id);

        // ----- the player's picks for the next run -----------------------------

        /// <summary>True if the player picked this strain for their next run.</summary>
        public static bool IsSelected(string id) => StrainCore.IsSelected(id);

        /// <summary>The registered strains picked for the next run.</summary>
        public static IReadOnlyList<StrainDefinition> Selected
        {
            get
            {
                var result = new List<StrainDefinition>();
                foreach (var def in StrainRegistry.All)
                    if (StrainCore.IsSelected(def.Id)) result.Add(def);
                return result;
            }
        }

        /// <summary>
        /// Pick or unpick a strain for the next run. Picking one deselects every strain it
        /// is incompatible with. Returns false for an unknown id. Never changes the run
        /// being played - see <see cref="Apply"/> for that.
        /// </summary>
        public static bool SetSelected(string id, bool selected)
        {
            var def = StrainRegistry.Get(id);
            if (def == null) return false;
            StrainCore.SetSelected(def, selected);
            return true;
        }

        /// <summary>Unpick every registered strain. Returns how many were picked.</summary>
        public static int ClearSelection() => StrainCore.ClearSelection();

        // ----- the run being played --------------------------------------------

        /// <summary>
        /// True from the moment a run starts or is continued until the player leaves it
        /// (back to the home menu). False in the menus and while StrainApi is disabled.
        /// </summary>
        public static bool IsRunInProgress => StrainCore.InRun;

        /// <summary>True while a game (one match) of the run is being played.</summary>
        public static bool IsGameInProgress => StrainCore.InGame;

        /// <summary>True once the API has found the game's GameManager and is following it.</summary>
        public static bool IsBound => StrainCore.IsBound;

        /// <summary>True if this strain is on the run being played.</summary>
        public static bool IsActive(string id) => StrainCore.Find(id) != null;

        /// <summary>The strains on the run being played; empty outside a run.</summary>
        public static IReadOnlyList<StrainDefinition> Active
        {
            get
            {
                var result = new List<StrainDefinition>();
                foreach (var b in StrainCore.Live) result.Add(b.Definition);
                return result;
            }
        }

        /// <summary>The live behaviour of an active strain, or null.</summary>
        public static StrainBehaviour GetBehaviour(string id) => StrainCore.Find(id);

        /// <summary>The live behaviour of the first active strain of type <typeparamref name="T"/>, or null.</summary>
        public static T GetBehaviour<T>() where T : StrainBehaviour
        {
            foreach (var b in StrainCore.Live)
                if (b is T typed) return typed;
            return null;
        }

        /// <summary>
        /// Put a strain on the run being played, now. For testing and cheats: it gets
        /// OnActivate, then OnRunStarted, then OnGameStarted if a game is on - what a run
        /// started with it would have seen by now - and the saved run remembers it.
        /// False (with the reason in <paramref name="error"/>) outside a run, if it is
        /// already on, or if it conflicts with a strain that is.
        /// </summary>
        public static bool Apply(string id, out string error)
        {
            var def = StrainRegistry.Get(id);
            if (def == null) { error = $"no strain '{id}' is registered"; return false; }
            return StrainCore.Apply(def, out error);
        }

        /// <summary>Take a strain off the run being played, now; the saved run forgets it too.</summary>
        public static bool Remove(string id, out string error)
        {
            var def = StrainRegistry.Get(id);
            if (def == null) { error = $"no strain '{id}' is registered"; return false; }
            return StrainCore.Remove(def, out error);
        }

        // ----- the game's own strains ------------------------------------------

        /// <summary>
        /// True if one of the game's own strains is on - the same flag the game checks
        /// (<c>StrainManager.ActivatedStrain</c>), so a gambit or a mod strain can honour
        /// it: <c>Strains.IsVanillaActive(Strain.TILE_EXHAUST)</c>. Meaningful during a
        /// run; between runs it still holds the last run's strains. False if the game's
        /// StrainManager is not up yet.
        /// </summary>
        public static bool IsVanillaActive(Strain strain) => StrainCore.IsVanillaActive(strain);

        /// <summary>Every one of the game's own strains that is on (see <see cref="IsVanillaActive"/>).</summary>
        public static IReadOnlyList<Strain> VanillaActive => StrainCore.VanillaActive();

        // ----- events --------------------------------------------------------

        /// <summary>A new run started. The run's strains are already active and have had OnRunStarted.</summary>
        public static event Action OnRunStarted
        {
            add => StrainCore.RunStarted += value;
            remove => StrainCore.RunStarted -= value;
        }

        /// <summary>A saved run was continued. Its strains are already active again.</summary>
        public static event Action OnRunResumed
        {
            add => StrainCore.RunResumed += value;
            remove => StrainCore.RunResumed -= value;
        }

        /// <summary>
        /// The player left the run: back to the home menu, whether they quit, lost or won.
        /// The game does not say which, and a run left mid-way can still be continued.
        /// </summary>
        public static event Action OnRunLeft
        {
            add => StrainCore.RunLeft += value;
            remove => StrainCore.RunLeft -= value;
        }

        /// <summary>The player's picks for the next run changed.</summary>
        public static event Action OnSelectionChanged
        {
            add => StrainCore.SelectionChanged += value;
            remove => StrainCore.SelectionChanged -= value;
        }
    }
}
