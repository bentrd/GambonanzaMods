using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.CompilerServices;
using Blukulele.CHE;

namespace Gambonanza.CrumbleApi
{
    /// <summary>
    /// What a <see cref="CrumbleHandle"/> does while it is alive.
    /// </summary>
    public enum CrumbleHandleKind
    {
        /// <summary>
        /// Pauses the crumble entirely: the countdown does not tick, tiles that are
        /// shaking do not fall, and the crumble picks no new tiles. Everything resumes
        /// where it left off once the last freeze handle is released. Tiles the Mask
        /// boss, a Crumbler enemy or the heavy-landing strain shake outside the per-turn
        /// step still queue up while frozen and fall together on the first step after.
        /// </summary>
        Freeze,

        /// <summary>
        /// Crumble mode cannot begin. The countdown still ticks but stalls one turn
        /// short of the threshold. Has no effect on a crumble that is already under
        /// way - use <see cref="Crumble.Stop"/> for that.
        /// </summary>
        Block,

        /// <summary>
        /// Adds turns to the countdown. Several delays stack; the total is capped at
        /// <see cref="Crumble.MaxExtraTurns"/>. Use <see cref="Block"/> for "never".
        /// </summary>
        Delay,
    }

    /// <summary>
    /// A modifier on the crumble, owned by whoever asked for it. Dispose it to
    /// release it. Pass the gambit (or any Unity object) as the owner and the
    /// handle releases itself when that object is destroyed, so a gambit that is
    /// sold or lost never leaves a stale freeze behind.
    /// </summary>
    public sealed class CrumbleHandle : IDisposable
    {
        public CrumbleHandleKind Kind { get; }

        /// <summary>The Unity object this handle is tied to, or null.</summary>
        public UnityEngine.Object Owner { get; }

        /// <summary>Who holds it, for diagnostics (the console's `crumble` status lists these).</summary>
        public string Label { get; }

        /// <summary>False once disposed (explicitly, or because the owner was destroyed).</summary>
        public bool IsActive => !_disposed && !OwnerGone;

        private readonly bool _hasOwner;
        private bool _disposed;
        private int _turns;

        /// <summary>
        /// For <see cref="CrumbleHandleKind.Delay"/>: how many turns this handle adds.
        /// Settable, so a gambit can grow its delay over a run without re-creating
        /// the handle. Ignored (always 0) for other kinds.
        /// </summary>
        public int Turns
        {
            get => _turns;
            set
            {
                if (Kind != CrumbleHandleKind.Delay) { CrumbleCore.Log($"Turns set on a {Kind} handle ({Label}); ignored."); return; }
                if (_disposed) { CrumbleCore.Log($"Turns set on a released Delay handle ({Label}); ignored."); return; }
                var clamped = Math.Max(0, Math.Min(Crumble.MaxExtraTurns, value));
                if (clamped == _turns) return;
                _turns = clamped;
                CrumbleCore.HandlesChanged();
            }
        }

        internal CrumbleHandle(CrumbleHandleKind kind, int turns, UnityEngine.Object owner, string label)
        {
            Kind = kind;
            Owner = owner;
            _hasOwner = !ReferenceEquals(owner, null);
            Label = label;
            _turns = kind == CrumbleHandleKind.Delay ? Math.Max(0, Math.Min(Crumble.MaxExtraTurns, turns)) : 0;
        }

        /// <summary>True when an owner was given and Unity has since destroyed it.</summary>
        internal bool OwnerGone => _hasOwner && !Owner;

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            CrumbleCore.Release(this);
        }
    }

    /// <summary>
    /// Static entry point of the Crumble Control API. Reference Gambonanza.CrumbleApi.dll,
    /// list "CrumbleApi" under "dependencies" in your mod.json, and call these from a
    /// gambit, a mod, or the console.
    ///
    /// Three ways to bend the crumble, each returning a handle you dispose to undo it:
    ///   Freeze(owner)      - pause everything (countdown, falling, spreading)
    ///   Block(owner)       - crumble mode can never start while held
    ///   Delay(turns, owner) - lengthen the countdown by N turns
    ///
    /// Plus direct actions: Start(), Stop(), TurnCounter, ShakeTile(), CalmTile(),
    /// RestoreTile(). And two events, OnBeforeStep / OnAfterStep, fired around the
    /// game's own per-turn crumble step for anything the handles do not cover.
    ///
    /// Everything is safe to call before the game has spawned its CrumbleManager
    /// (during OnLoad, in the menu): handles are remembered and applied once the
    /// manager exists, reads return zero/false, and actions are no-ops.
    /// </summary>
    public static class Crumble
    {
        /// <summary>Upper bound on the summed <see cref="Delay"/> turns. One indicator light is drawn per turn.</summary>
        public const int MaxExtraTurns = 500;

        // ----- state ---------------------------------------------------------

        /// <summary>True once the API has found the game's CrumbleManager and hooked its per-turn step.</summary>
        public static bool IsBound => CrumbleCore.IsBound;

        /// <summary>The live CrumbleManager, for anything this API does not wrap. Null until bound.</summary>
        public static CrumbleManager Manager => CrumbleCore.Manager;

        /// <summary>
        /// True while crumble mode is on. Reads the game's CrumbleMode flag, except that
        /// a frozen crumble still reads true for the few frames the API masks the flag
        /// around the game's step. Setting it flips the raw flag only - prefer
        /// <see cref="Start"/> / <see cref="Stop"/>, which also handle the counter,
        /// particles, shaking tiles and the start-of-crumble events.
        /// </summary>
        public static bool IsActive
        {
            get => CrumbleCore.LogicalCrumbleMode;
            set { var cm = CrumbleCore.Manager; if (cm != null) cm.CrumbleMode = value; }
        }

        /// <summary>
        /// Turns played this stage, as the game counts them: a capture skips the next
        /// tick, and so does using Wait while a Clock enemy is on the board. Setting it
        /// also updates the indicator lights.
        /// </summary>
        public static int TurnCounter
        {
            get => CrumbleCore.Manager != null ? CrumbleCore.Manager.TurnCounter : 0;
            set => CrumbleCore.SetTurnCounter(value);
        }

        /// <summary>The wait the game itself uses before any <see cref="Delay"/>: read from the scene once (5 turns in current builds).</summary>
        public static int BaseTurnsToWait => CrumbleCore.BaseTurnsToWait;

        /// <summary>Extra turns currently added by <see cref="Delay"/> handles, after the cap.</summary>
        public static int ExtraTurns => CrumbleCore.ExtraTurns;

        /// <summary>What the game is using right now: base + extra. This is CrumbleManager.TurnToWait.</summary>
        public static int TurnsToWait => CrumbleCore.Manager != null ? CrumbleCore.Manager.TurnToWait : 0;

        /// <summary>
        /// The game's per-wave addition to the countdown: 0 for the first five stages,
        /// then +1 per five stages up to 5. With Better AI it is (that + 1) x 1.5 rounded
        /// up, so 2 on the first five stages and up to 9.
        /// </summary>
        public static int WaveBonusTurns => CrumbleCore.WaveBonusTurns;

        /// <summary>The counter value at which crumble mode begins: TurnsToWait + WaveBonusTurns.</summary>
        public static int Threshold => TurnsToWait + WaveBonusTurns;

        /// <summary>Turns left before crumble mode begins; 0 once it is on.</summary>
        public static int TurnsUntilCrumble => IsActive ? 0 : Math.Max(0, Threshold - TurnCounter);

        /// <summary>
        /// The game's one-shot "do not tick this turn" flag. The game sets it on a
        /// capture, and when the player uses Wait while a Clock enemy is on the board;
        /// it clears itself after each step. Set it from <see cref="OnBeforeStep"/> to
        /// skip a single tick by hand.
        /// </summary>
        public static bool SkipNextIncrement
        {
            get => CrumbleCore.GetSkipIncrement();
            set => CrumbleCore.SetSkipIncrement(value);
        }

        /// <summary>True while at least one live <see cref="Freeze"/> handle exists.</summary>
        public static bool IsFrozen => CrumbleCore.IsFrozen;

        /// <summary>True while at least one live <see cref="Block"/> handle exists.</summary>
        public static bool IsBlocked => CrumbleCore.IsBlocked;

        /// <summary>The game's flag for "a Crumbler enemy is on the board" (its tiles fall every turn).</summary>
        public static bool CrumblerInGame
        {
            get => CrumbleCore.Manager != null && CrumbleCore.Manager.CrumblerInGame;
            set { var cm = CrumbleCore.Manager; if (cm != null) cm.CrumblerInGame = value; }
        }

        /// <summary>Tiles currently shaking (they fall on the next crumble step). A copy.</summary>
        public static IReadOnlyList<TileBehaviour> ShakingTiles => CrumbleCore.CopyTiles(shaking: true);

        /// <summary>Tiles that have fallen this stage. A copy.</summary>
        public static IReadOnlyList<TileBehaviour> FallenTiles => CrumbleCore.CopyTiles(shaking: false);

        /// <summary>Every live handle, for diagnostics.</summary>
        public static IReadOnlyList<CrumbleHandle> Handles => CrumbleCore.Handles;

        // ----- events --------------------------------------------------------

        /// <summary>
        /// Fired at the start of each player turn, just before the game's own crumble
        /// step (the one that ticks the counter, starts crumble mode, drops shaking
        /// tiles and shakes new ones). Handles are applied after this fires, so
        /// anything you set here (e.g. <see cref="SkipNextIncrement"/>) is honoured.
        /// </summary>
        public static event Action OnBeforeStep
        {
            add => CrumbleCore.BeforeStep += value;
            remove => CrumbleCore.BeforeStep -= value;
        }

        /// <summary>Fired right after the game's crumble step for the turn.</summary>
        public static event Action OnAfterStep
        {
            add => CrumbleCore.AfterStep += value;
            remove => CrumbleCore.AfterStep -= value;
        }

        // ----- modifiers -----------------------------------------------------

        /// <summary>
        /// Pause the crumble while the returned handle is alive. See
        /// <see cref="CrumbleHandleKind.Freeze"/>.
        /// </summary>
        /// <param name="owner">Optional Unity object; the handle auto-releases when it is destroyed.</param>
        /// <param name="label">Optional name for diagnostics; defaults to the owner or calling assembly.</param>
        [MethodImpl(MethodImplOptions.NoInlining)]
        public static CrumbleHandle Freeze(UnityEngine.Object owner = null, string label = null)
            => CrumbleCore.Add(CrumbleHandleKind.Freeze, 0, owner, label ?? DefaultLabel(owner, Assembly.GetCallingAssembly()));

        /// <summary>
        /// Prevent crumble mode from starting while the returned handle is alive. See
        /// <see cref="CrumbleHandleKind.Block"/>.
        /// </summary>
        [MethodImpl(MethodImplOptions.NoInlining)]
        public static CrumbleHandle Block(UnityEngine.Object owner = null, string label = null)
            => CrumbleCore.Add(CrumbleHandleKind.Block, 0, owner, label ?? DefaultLabel(owner, Assembly.GetCallingAssembly()));

        /// <summary>
        /// Lengthen the countdown by <paramref name="turns"/> while the returned handle
        /// is alive. See <see cref="CrumbleHandleKind.Delay"/>. Applies immediately,
        /// including to the indicator lights of a stage in progress. A saved run resumes
        /// against it too: the game decides "resume in crumble mode" before gambits are
        /// re-created, so when a Delay lands during a just-loaded stage and the counter
        /// is below the new threshold, the API undoes that relaunch.
        /// </summary>
        [MethodImpl(MethodImplOptions.NoInlining)]
        public static CrumbleHandle Delay(int turns, UnityEngine.Object owner = null, string label = null)
            => CrumbleCore.Add(CrumbleHandleKind.Delay, turns, owner, label ?? DefaultLabel(owner, Assembly.GetCallingAssembly()));

        // ----- direct actions ------------------------------------------------

        /// <summary>
        /// Begin crumble mode now, exactly as the game does when the countdown runs out:
        /// the counter is raised to the threshold (so a save resumes in crumble mode and
        /// the enemy AI reads full urgency), OnCrumble fires (Scepter, Chamberlain and
        /// the like react), the CRUMBLE build influence grows, the particles play and the
        /// banner shows. No-op if already active. Pass <c>fireEvents: false</c> to skip
        /// the OnCrumble/influence part, which is what the game itself does when resuming
        /// a saved run. Note that the game invokes OnCrumble before it commits the flag,
        /// so an OnCrumble subscriber cannot veto a crumble; use <see cref="Block"/> to
        /// prevent one and <see cref="OnAfterStep"/> to react once it is on.
        /// </summary>
        public static void Start(bool fireEvents = true) => CrumbleCore.StartCrumble(fireEvents);

        /// <summary>
        /// End crumble mode: the flag drops, the particles stop, every shaking tile
        /// settles, and (by default) the countdown restarts from zero so the crumble
        /// comes back the normal way later. With <c>resetCounter: false</c> the counter
        /// keeps its value, so unless a Block or Delay is in place the next turn will
        /// start the crumble again - fanfare included.
        /// </summary>
        public static void Stop(bool resetCounter = true) => CrumbleCore.StopCrumble(resetCounter);

        /// <summary>
        /// Make a tile shake (the game's own CrumblerEffect). Shaking tiles fall on the
        /// next step only while something drives the crumble: crumble mode, a Crumbler
        /// enemy, the Mask boss or the CRUMBLE_STOCK_TO_BOARD strain. Otherwise they
        /// keep shaking until one of those starts, or until <see cref="CalmTile"/>.
        /// </summary>
        public static void ShakeTile(TileBehaviour tile) => CrumbleCore.ShakeTile(tile);

        /// <summary>Stop a tile shaking and forget it, so it will not fall.</summary>
        public static void CalmTile(TileBehaviour tile) => CrumbleCore.CalmTile(tile);

        /// <summary>Bring a fallen tile back and forget it, as the game does between stages.</summary>
        public static void RestoreTile(TileBehaviour tile) => CrumbleCore.RestoreTile(tile);

        /// <summary>
        /// Run the game's own "pick the next tiles to shake" once (2 tiles, 3 with the
        /// BIG CRUMBLE strain, drawn from the run's seeded random). Works whether or
        /// not crumble mode is on, but see <see cref="ShakeTile"/> for when they fall.
        /// </summary>
        public static void ShakeNextBatch() => CrumbleCore.ShakeNextBatch();

        /// <summary>
        /// Rebuild the on-screen countdown indicator from the current numbers. The
        /// API calls this itself after anything it changes; you only need it after
        /// poking the manager directly.
        /// </summary>
        public static void RefreshIndicator() => CrumbleCore.RequestIndicatorRebuild();

        // A gambit is a clone of a vanilla template, so its GameObject name is the
        // template's ("Addiction_Gambit(Clone)"); the component type is the name a
        // modder will recognise. Without an owner, the caller's assembly: the public
        // wrappers are NoInlining so their GetCallingAssembly() is the consumer's.
        private static string DefaultLabel(UnityEngine.Object owner, Assembly caller)
        {
            try
            {
                if (owner) return owner is UnityEngine.Component c ? c.GetType().Name : owner.name;
                return caller != null ? caller.GetName().Name : "unknown";
            }
            catch { return "unknown"; }
        }
    }
}
