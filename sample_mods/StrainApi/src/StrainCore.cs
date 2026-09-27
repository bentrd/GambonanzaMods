using System;
using System.Collections.Generic;
using Blukulele.CHE;
using Blukulele.Core;
using UnityEngine;

namespace Gambonanza.StrainApi
{
    /// <summary>
    /// The machinery behind <see cref="Strains"/>: follows the player in and out of runs
    /// and keeps one <see cref="StrainBehaviour"/> alive per strain on the run being played.
    ///
    /// The game raises no "run started" or "run over" event, so the run is followed from
    /// GameManager.onStateChanged, plus a poll of CurrentState in case a transition is
    /// ever made without the event. <see cref="PhaseOf"/> says what each state means and
    /// <see cref="RunTracker"/> (pure logic, unit-tested) turns the sequence into run and
    /// game events; this class carries them out: spawning and putting away strain
    /// behaviours, recording the run's strains so Continue brings them back, hooking the
    /// player's turns.
    /// </summary>
    internal static class StrainCore
    {
        internal static Action<string> Logger;

        internal static event Action RunStarted;
        internal static event Action RunResumed;
        internal static event Action RunLeft;
        internal static event Action SelectionChanged;

        private static bool _enabled;
        private static GameObject _root;                 // hosts the ticker and parents the strain objects

        private static GameManager _gm;
        private static bool _hasLastState;
        private static State _lastState;
        private static readonly Action<State> _onState = OnStateChanged;

        private static TurnManager _tm;
        private static readonly Action _onTurn = OnPlayerTurnHook;

        private static readonly RunTracker _tracker = new RunTracker(new TrackerListener());

        private static readonly List<StrainBehaviour> _live = new List<StrainBehaviour>();

        private static string _lastTickError;
        private static float _nextTickErrorLog;

        // ----- reads ----------------------------------------------------------

        internal static bool IsEnabled => _enabled;
        internal static bool IsBound => _enabled && _gm;
        internal static bool InRun => _enabled && _tracker.InRun;
        internal static bool InGame => InRun && _tracker.InGame;
        internal static string GameState => _gm ? _gm.CurrentState.ToString() : "unknown";

        internal static IReadOnlyList<StrainBehaviour> Live
        {
            get
            {
                var result = new List<StrainBehaviour>();
                foreach (var b in _live) if (b) result.Add(b);
                return result;
            }
        }

        internal static StrainBehaviour Find(string id)
        {
            foreach (var b in _live)
                if (b && b.Id == id) return b;
            return null;
        }

        // ----- lifecycle ------------------------------------------------------

        internal static void Enable()
        {
            if (_enabled) return;
            _enabled = true;
            // No Tick() here: at boot this runs inside GameManager.Start, before the game
            // has settled on its first state. The host's first Update binds a frame later.
            _root = new GameObject("__StrainApiHost");
            UnityEngine.Object.DontDestroyOnLoad(_root);
            _root.hideFlags = HideFlags.HideAndDontSave;
            _root.AddComponent<StrainApiHost>();
        }

        internal static void Disable()
        {
            if (!_enabled) return;
            try
            {
                // Not "leaving the run": the player is still in it. Put the strains away
                // (their OnDeactivate/OnDestroy undo what they did); re-enabling the API
                // brings them back the way Continue would.
                if (_tracker.InRun)
                {
                    int n = _live.Count;
                    if (_tracker.InGame) Broadcast(StrainEvent.GameEnded);
                    PutAwayAll();
                    Log($"disabled mid-run; put away {n} strain(s). Re-enabling brings them back.");
                }
                UnhookTurns();
                if (_gm) _gm.onStateChanged = (Action<State>)Delegate.Remove(_gm.onStateChanged, _onState);
                StrainPicker.Teardown();
            }
            catch (Exception ex) { Log("disable cleanup failed: " + ex.Message); }

            if (_root) UnityEngine.Object.Destroy(_root);
            _root = null;
            _gm = null;
            _hasLastState = false;
            _tracker.Reset();
            _enabled = false;
        }

        /// <summary>Called by the host a few times a second.</summary>
        internal static void Tick()
        {
            if (!_enabled) return;
            try
            {
                BindGameManager();
                PollState();
                EnsureTurnHook();
                PruneDestroyed();
                if (_gm && _gm.CurrentState == State.MENU) StrainPicker.EnsureHomeButton();
            }
            catch (Exception ex)
            {
                // A persistent failure must not fill Player.log four times a second.
                var msg = "tick failed: " + ex.Message;
                if (msg != _lastTickError || Time.unscaledTime >= _nextTickErrorLog)
                {
                    _lastTickError = msg;
                    _nextTickErrorLog = Time.unscaledTime + 30f;
                    Log(msg + " (repeats are logged at most every 30s)");
                }
            }
        }

        // ----- following the game --------------------------------------------

        private static void BindGameManager()
        {
            if (_gm) return;
            _gm = null;
            if (!SingletonMonoBehaviour<GameManager>.IsCreated()) return;
            var gm = SingletonMonoBehaviour<GameManager>.Instance;
            if (!gm) return;
            // A plain multicast field, not an event: remove-then-combine keeps exactly one copy.
            gm.onStateChanged = (Action<State>)Delegate.Combine(
                Delegate.Remove(gm.onStateChanged, _onState), _onState);
            _gm = gm;
            Log($"bound to GameManager (state {gm.CurrentState}).");
            CatchUp(gm.CurrentState);
        }

        private static void CatchUp(State state)
        {
            _lastState = state;
            _hasLastState = true;
            _tracker.CatchUp(PhaseOf(state), ReadWave());
        }

        private static void PollState()
        {
            if (_gm) OnStateChanged(_gm.CurrentState);
        }

        private static void OnStateChanged(State state)
        {
            if (!_enabled) return;
            if (_hasLastState && state == _lastState) return;   // not a change (event + poll both report it)
            _lastState = state;
            _hasLastState = true;
            try { _tracker.OnPhase(PhaseOf(state), _gm && _gm.PreviousState == State.LOAD_RUN, ReadWave()); }
            catch (Exception ex) { Log($"handling the change to {state} failed: {ex}"); }
        }

        /// <summary>
        /// What each game state means for the run. MENU is where every way out of a run
        /// ends (pause -> Main Menu goes PauseMenu.CloseAndBackToMainMenu -> GameManager.Menu,
        /// and so do the game-over screen and the end of a won run). The Opening, Game, Shop
        /// and Between states only happen inside a run. Everything else - PAUSE, SETTINGS,
        /// RUN_INFO, PROMOTION, the collection - changes nothing; the game re-enters INGAME
        /// when those close, which is the same game carrying on.
        /// </summary>
        private static RunPhase PhaseOf(State state)
        {
            switch (state)
            {
                case State.MENU:            return RunPhase.Menu;
                case State.LOAD_RUN:        return RunPhase.Loading;
                case State.PIECE_SELECTION:
                case State.BOARD_PLACEMENT: return RunPhase.Opening;
                case State.INGAME:          return RunPhase.Game;
                case State.SHOP:            return RunPhase.Shop;
                case State.WIN:
                case State.RESULT:
                case State.LOSE:
                case State.GRAVEYARD:
                case State.TILE_PLACEMENT:
                case State.GACHAPON:
                case State.WHEEL_GAME:
                case State.PACHINKO:        return RunPhase.Between;
                default:                    return RunPhase.Other;
            }
        }

        /// <summary>ChessDataManager.CurrentWave, the run's 0-based game index; -1 when there is none.</summary>
        private static int ReadWave()
        {
            try
            {
                if (!SingletonMonoBehaviour<ChessDataManager>.IsCreated()) return -1;
                var chess = SingletonMonoBehaviour<ChessDataManager>.Instance;
                return chess ? chess.CurrentWave : -1;
            }
            catch { return -1; }
        }

        // ----- runs (what the tracker reports) --------------------------------

        private static void OnRunStarted()
        {
            var data = StrainStore.Data;
            var picked = new List<StrainDefinition>();
            foreach (var def in StrainRegistry.All)
            {
                if (!data.selected.Contains(def.Id)) continue;
                var clash = picked.Find(p => p.ConflictsWith(def));
                if (clash != null) { Log($"'{def.Id}' cannot be combined with '{clash.Id}'; left off this run."); continue; }
                picked.Add(def);
            }
            data.runRecorded = true;
            data.runStrains = picked.ConvertAll(d => d.Id);
            StrainStore.Save();

            EnsureTurnHook();
            foreach (var def in picked) Spawn(def);
            Log(picked.Count == 0 ? "new run, no mod strains on it." : $"new run with {picked.Count} mod strain(s): {Names(picked)}.");
            Broadcast(StrainEvent.RunStarted);
            RaiseEvent(RunStarted, "OnRunStarted");
        }

        private static void OnRunResumed(string reason)
        {
            EnsureTurnHook();
            var data = StrainStore.Data;
            if (!data.runRecorded)
            {
                Log($"{reason}; no strains were recorded for it.");
                RaiseEvent(RunResumed, "OnRunResumed");
                return;
            }

            var back = new List<StrainDefinition>();
            var missing = new List<string>();
            foreach (var id in data.runStrains)
            {
                var def = StrainRegistry.Get(id);
                if (def == null) { missing.Add(id); continue; }
                if (Spawn(def) != null) back.Add(def);
            }
            Log($"{reason}; {(back.Count == 0 ? "no mod strains on it" : $"{back.Count} mod strain(s) back: {Names(back)}")}" +
                (missing.Count > 0 ? $". Not installed, so not applied: {string.Join(", ", missing)}." : "."));
            RaiseEvent(RunResumed, "OnRunResumed");
        }

        private static void OnRunLeft(string reason)
        {
            int n = _live.Count;
            PutAwayAll();
            UnhookTurns();
            Log($"left the run ({reason}); put away {n} strain(s).");
            RaiseEvent(RunLeft, "OnRunLeft");
        }

        /// <summary>Routes <see cref="RunTracker"/>'s reports into this static class.</summary>
        private sealed class TrackerListener : IRunListener
        {
            public void RunStarted() => OnRunStarted();
            public void RunResumed(string reason) => OnRunResumed(reason);
            public void RunLeft(string reason) => OnRunLeft(reason);
            public void GameStarted() => Broadcast(StrainEvent.GameStarted);
            public void GameEnded() => Broadcast(StrainEvent.GameEnded);
            public void ShopOpened() => Broadcast(StrainEvent.ShopOpened);
        }

        // ----- strain objects -------------------------------------------------

        private static StrainBehaviour Spawn(StrainDefinition def)
        {
            var existing = Find(def.Id);
            if (existing != null || !_root) return existing;

            GameObject go = null;
            StrainBehaviour behaviour = null;
            try
            {
                go = new GameObject("Strain " + def.Id);
                go.SetActive(false);                              // hold Awake until Definition is set
                go.transform.SetParent(_root.transform, false);
                behaviour = (StrainBehaviour)go.AddComponent(def.BehaviourType ?? typeof(DelegateStrainBehaviour));
                behaviour.Bind(def);
                _live.Add(behaviour);
                go.SetActive(true);
            }
            catch (Exception ex)
            {
                Log($"strain '{def.Id}' failed to start: {ex}");
                if (behaviour != null) _live.Remove(behaviour);
                if (go) UnityEngine.Object.Destroy(go);
                return null;
            }
            behaviour.RunHook(def.Activated, StrainEvent.Activated);
            return behaviour;
        }

        private static void PutAway(StrainBehaviour behaviour)
        {
            _live.Remove(behaviour);
            if (!behaviour) return;
            behaviour.RunHook(behaviour.Definition?.Deactivated, StrainEvent.Deactivated);
            try
            {
                // Inactive right away (OnDisable now, no more Update); destroyed at the
                // end of the frame (OnDestroy).
                behaviour.gameObject.SetActive(false);
                UnityEngine.Object.Destroy(behaviour.gameObject);
            }
            catch (Exception ex) { Log($"strain '{behaviour.Id}' did not shut down cleanly: {ex.Message}"); }
        }

        private static void PutAwayAll()
        {
            foreach (var b in _live.ToArray()) PutAway(b);
            _live.Clear();
        }

        private static void PruneDestroyed()
        {
            for (int i = _live.Count - 1; i >= 0; i--)
            {
                if (_live[i]) continue;
                Log($"strain '{_live[i].Id}' had its object destroyed from outside StrainApi; it is off until the run is resumed.");
                _live.RemoveAt(i);
            }
        }

        private static void Broadcast(StrainEvent evt)
        {
            foreach (var b in _live.ToArray())
                if (b) b.Raise(evt);
        }

        // ----- per-turn hook ----------------------------------------------------

        /// <summary>
        /// TurnManager.OnPlayerTurn is the game's own start-of-player-turn multicast (a
        /// plain field). We append to it for as long as a run is in progress, and re-add
        /// ourselves should anything rebuild the list or the manager be replaced.
        /// </summary>
        private static void EnsureTurnHook()
        {
            if (!_tracker.InRun) { UnhookTurns(); return; }
            TurnManager tm = null;
            try { if (SingletonMonoBehaviour<TurnManager>.IsCreated()) tm = SingletonMonoBehaviour<TurnManager>.Instance; }
            catch { }
            if (!ReferenceEquals(tm, _tm)) { UnhookTurns(); _tm = tm; }
            if (!_tm) return;
            var current = _tm.OnPlayerTurn;
            if (current != null && Array.IndexOf(current.GetInvocationList(), _onTurn) >= 0) return;
            _tm.OnPlayerTurn = (Action)Delegate.Combine(current, _onTurn);
        }

        private static void UnhookTurns()
        {
            if (_tm)
            {
                try { _tm.OnPlayerTurn = (Action)Delegate.Remove(_tm.OnPlayerTurn, _onTurn); }
                catch { }
            }
            _tm = null;
        }

        private static void OnPlayerTurnHook()
        {
            // Runs inside the game's multicast: throwing here would skip the game's own
            // handlers after us, so nothing may escape.
            try { if (InRun) Broadcast(StrainEvent.PlayerTurn); }
            catch (Exception ex) { Log("player-turn dispatch failed: " + ex.Message); }
        }

        // ----- the game's own strains -----------------------------------------

        /// <summary>StrainManager.ActivatedStrain: the game's strains on the current (or last) run.</summary>
        internal static bool IsVanillaActive(Strain strain)
        {
            try
            {
                if (!SingletonMonoBehaviour<StrainManager>.IsCreated()) return false;
                var manager = SingletonMonoBehaviour<StrainManager>.Instance;
                return manager && manager.ActivatedStrain[strain];
            }
            catch { return false; }
        }

        internal static List<Strain> VanillaActive()
        {
            var result = new List<Strain>();
            foreach (Strain strain in Enum.GetValues(typeof(Strain)))
                if (IsVanillaActive(strain)) result.Add(strain);
            return result;
        }

        // ----- selection and direct control -----------------------------------

        internal static bool IsSelected(string id) => id != null && StrainStore.Data.selected.Contains(id);

        internal static void SetSelected(StrainDefinition def, bool selected)
        {
            var list = StrainStore.Data.selected;
            bool changed = false;
            if (selected)
            {
                if (!list.Contains(def.Id)) { list.Add(def.Id); changed = true; }
                foreach (var other in StrainRegistry.All)
                {
                    if (!def.ConflictsWith(other) || !list.Remove(other.Id)) continue;
                    changed = true;
                    Log($"'{other.Id}' deselected: it cannot be combined with '{def.Id}'.");
                }
            }
            else changed = list.Remove(def.Id);

            if (!changed) return;
            StrainStore.Save();
            RaiseEvent(SelectionChanged, "OnSelectionChanged");
        }

        /// <summary>Deselect every registered strain. Picks for strains whose mod is missing are kept.</summary>
        internal static int ClearSelection()
        {
            int n = 0;
            foreach (var def in StrainRegistry.All)
                if (StrainStore.Data.selected.Remove(def.Id)) n++;
            if (n == 0) return 0;
            StrainStore.Save();
            RaiseEvent(SelectionChanged, "OnSelectionChanged");
            return n;
        }

        internal static bool Apply(StrainDefinition def, out string error)
        {
            error = null;
            if (!InRun) { error = "no run in progress - start or continue one first"; return false; }
            if (Find(def.Id) != null) { error = $"'{def.Id}' is already on this run"; return false; }
            foreach (var b in Live)
            {
                if (!b.Definition.ConflictsWith(def)) continue;
                error = $"'{def.Id}' cannot be combined with '{b.Id}', which is on this run";
                return false;
            }

            var behaviour = Spawn(def);
            if (behaviour == null) { error = "it failed to start (see the log)"; return false; }
            var data = StrainStore.Data;
            data.runRecorded = true;
            if (!data.runStrains.Contains(def.Id)) data.runStrains.Add(def.Id);
            StrainStore.Save();

            // What a run started with the strain would have seen by now.
            behaviour.Raise(StrainEvent.RunStarted);
            if (InGame) behaviour.Raise(StrainEvent.GameStarted);
            Log($"'{def.Id}' put on the current run.");
            return true;
        }

        internal static bool Remove(StrainDefinition def, out string error)
        {
            error = null;
            if (!InRun) { error = "no run in progress"; return false; }
            var behaviour = Find(def.Id);
            if (behaviour == null) { error = $"'{def.Id}' is not on this run"; return false; }
            if (InGame) behaviour.Raise(StrainEvent.GameEnded);
            PutAway(behaviour);
            if (StrainStore.Data.runStrains.Remove(def.Id)) StrainStore.Save();
            Log($"'{def.Id}' taken off the current run.");
            return true;
        }

        // ----- registry callbacks ---------------------------------------------

        /// <summary>
        /// A strain registered while its run is being played (a mod enabled mid-run) comes
        /// in the way a continued run would bring it back.
        /// </summary>
        internal static void OnRegistered(StrainDefinition def)
        {
            if (!InRun) return;
            var data = StrainStore.Data;
            if (!data.runRecorded || !data.runStrains.Contains(def.Id) || Find(def.Id) != null) return;
            if (Spawn(def) != null) Log($"'{def.Id}' registered mid-run and is on this run; started it.");
        }

        internal static void OnUnregistering(StrainDefinition def)
        {
            var behaviour = Find(def.Id);
            if (behaviour == null) return;
            if (InGame) behaviour.Raise(StrainEvent.GameEnded);
            PutAway(behaviour);
        }

        // ----- plumbing -------------------------------------------------------

        private static string Names(List<StrainDefinition> defs) => string.Join(", ", defs.ConvertAll(d => d.Id));

        /// <summary>Each subscriber is isolated: one that throws is logged and the rest still run.</summary>
        private static void RaiseEvent(Action evt, string name)
        {
            if (evt == null) return;
            foreach (var d in evt.GetInvocationList())
            {
                try { ((Action)d)(); }
                catch (Exception ex) { Log($"a Strains.{name} handler threw: {ex}"); }
            }
        }

        internal static void Log(string message)
        {
            try
            {
                if (Logger != null) Logger(message);
                else Debug.Log("[StrainApi] " + message);
            }
            catch { }
        }
    }

    /// <summary>Scene-persistent ticker for <see cref="StrainCore"/>.</summary>
    internal sealed class StrainApiHost : MonoBehaviour
    {
        private float _nextTick;

        private void Update()
        {
            if (Time.unscaledTime < _nextTick) return;
            _nextTick = Time.unscaledTime + 0.25f;
            StrainCore.Tick();
        }
    }
}
