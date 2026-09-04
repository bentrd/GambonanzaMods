using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using Blukulele.CHE;
using Blukulele.Core;
using UnityEngine;
using UnityEngine.UI;

namespace Gambonanza.CrumbleApi
{
    /// <summary>
    /// The machinery behind <see cref="Crumble"/>. Binds to the game's CrumbleManager by
    /// reflection and brackets its private per-turn step with a before and an after hook.
    ///
    /// How the hook works, since there is no Harmony here: CrumbleManager.Start subscribes
    /// its private PlayerTurnEffects to TurnManager.OnPlayerCheckIfCanPlay, a plain
    /// multicast Action. Multicast delegates invoke in subscription order, and a delegate
    /// built with Delegate.CreateDelegate over the same target and method compares equal
    /// to the game's own, so we can find it in the invocation list and rebuild the list
    /// as [..., before, PlayerTurnEffects, after, ...]. Nothing else in the game
    /// subscribes to that event (verified against builds 24858528 and 25059529, whose
    /// crumble code is byte-identical), and the rebuild is idempotent, so we re-check
    /// it a few times a second and repair it if anything re-subscribes.
    ///
    /// What the step does in vanilla, for reference (CrumbleManager.PlayerTurnEffects):
    ///   1. unless m_SkipIncrement: TurnCounter++, OnIncrease
    ///   2. if TurnCounter >= TurnToWait + GetCrumbleTurnCount(): start crumble mode
    ///   3. if CrumbleMode || MaskBoss || CrumblerInGame || CRUMBLE_STOCK_TO_BOARD strain:
    ///      drop every tile in m_CrumbleTiles now, then next frame pick new ones to
    ///      shake (only while CrumbleMode)
    /// Freeze masks CrumbleMode/CrumblerInGame and swaps in an empty tile list for the
    /// duration of the step; Block clamps the counter one short of the threshold and
    /// skips the tick; Delay rewrites the private m_TurnToWait so every reader of
    /// TurnToWait (indicator, enemy AI urgency, save/load) sees the longer wait.
    /// </summary>
    internal static class CrumbleCore
    {
        private const BindingFlags Priv = BindingFlags.NonPublic | BindingFlags.Instance;

        // ----- CrumbleManager privates ---------------------------------------
        private static readonly FieldInfo  FTurnToWait        = typeof(CrumbleManager).GetField("m_TurnToWait", Priv);
        private static readonly FieldInfo  FSkipIncrement     = typeof(CrumbleManager).GetField("m_SkipIncrement", Priv);
        private static readonly FieldInfo  FCrumbleTiles      = typeof(CrumbleManager).GetField("m_CrumbleTiles", Priv);
        private static readonly FieldInfo  FFellTiles         = typeof(CrumbleManager).GetField("m_FellTiles", Priv);
        private static readonly FieldInfo  FParticles         = typeof(CrumbleManager).GetField("m_PS_CrumbleMode", Priv);
        private static readonly MethodInfo MPlayerTurnEffects = typeof(CrumbleManager).GetMethod("PlayerTurnEffects", Priv);
        private static readonly MethodInfo MSelectTilesToShake= typeof(CrumbleManager).GetMethod("SelectTilesToShake", Priv);

        // ----- CrumbleIndicator privates (the row of lights under the board) --
        private static readonly FieldInfo  FIndCounter        = typeof(CrumbleIndicator).GetField("m_Counter", Priv);
        private static readonly FieldInfo  FIndHintParent     = typeof(CrumbleIndicator).GetField("m_HintParent", Priv);
        private static readonly FieldInfo  FIndHintVisual     = typeof(CrumbleIndicator).GetField("m_HintVisual", Priv);
        private static readonly FieldInfo  FIndLightOn        = typeof(CrumbleIndicator).GetField("m_LightOnColor", Priv);
        private static readonly MethodInfo MIndDestroyChildren= typeof(CrumbleIndicator).GetMethod("DestroyChildren", Priv);
        private static readonly MethodInfo MIndCreateChildren = typeof(CrumbleIndicator).GetMethod("CreateChildren", Priv);

        internal static Action<string> Logger;

        private static CrumbleApiHost _host;
        private static bool _enabled;
        private static CrumbleManager _cm;
        private static TurnManager _tm;
        private static Action _cmHandler;   // the game's own PlayerTurnEffects delegate on _cm
        private static Action _installed;   // the multicast we last wrote into TurnManager
        private static int _baseTurnToWait = 3;

        private static readonly List<CrumbleHandle> _handles = new List<CrumbleHandle>();
        private static readonly Action _before = OnBeforeStepHook;
        private static readonly Action _after  = OnAfterStepHook;

        internal static event Action BeforeStep;
        internal static event Action AfterStep;

        // Per-step scratch: what the before hook changed, for the after hook to undo.
        private static bool _stepOpen;
        private static bool _restoreCrumbleMode;
        private static bool _restoreCrumblerInGame;
        private static bool _restoreTurnToWait;
        private static int _savedTurnToWait;
        private static List<TileBehaviour> _realTiles;
        private static int _restoreToken;
        private static bool _restorePending;

        // Throttle for the tick-failure log: a persistent failure must not fill Player.log
        // four times a second.
        private static string _lastTickError;
        private static float _nextTickErrorLog;

        /// <summary>
        /// Crumble mode as consumers should see it: the game's flag, plus the few frames
        /// around a frozen step where the API has masked that flag to keep the game's
        /// fall coroutine from picking new tiles.
        /// </summary>
        internal static bool LogicalCrumbleMode
            => _cm != null && (_cm.CrumbleMode || _restorePending || (_stepOpen && _restoreCrumbleMode));

        private static CrumbleIndicator _indicator;
        private static bool _indicatorRebuildQueued;

        // ----- lifecycle ------------------------------------------------------

        internal static void Enable()
        {
            _enabled = true;
            WarnIfGameChanged();
            if (_host == null)
            {
                var go = new GameObject("__CrumbleApiHost");
                UnityEngine.Object.DontDestroyOnLoad(go);
                go.hideFlags = HideFlags.HideAndDontSave;
                _host = go.AddComponent<CrumbleApiHost>();
            }
            Tick();
        }

        internal static void Disable()
        {
            _enabled = false;
            try
            {
                if (_restorePending && _cm != null) { _cm.CrumbleMode = true; _restorePending = false; }
                Uninstall();
                if (_cm != null && FTurnToWait != null)
                {
                    bool changed = (int)FTurnToWait.GetValue(_cm) != _baseTurnToWait;
                    FTurnToWait.SetValue(_cm, _baseTurnToWait);
                    // The host is about to go, so the row cannot be rebuilt by coroutine:
                    // do it now. Destroy() lands at end of frame while CreateChildren
                    // instantiates immediately, which is what the game's own
                    // CO_Initialize does too.
                    if (changed && InGame) RebuildIndicatorNow();
                }
            }
            catch (Exception ex) { Log("disable cleanup failed: " + ex.Message); }
            if (_host != null)
            {
                try { UnityEngine.Object.Destroy(_host.gameObject); } catch { }
                _host = null;
            }
            _cm = null; _tm = null; _cmHandler = null; _installed = null; _indicator = null;
            _indicatorRebuildQueued = false;
        }

        /// <summary>Called by the host a few times a second: find the manager, keep the hook in place.</summary>
        internal static void Tick()
        {
            if (!_enabled) return;
            try
            {
                var cm = FindManager();
                if (cm == null)
                {
                    if (_cm != null) { Log("CrumbleManager went away; waiting for a new one."); _cm = null; _cmHandler = null; _installed = null; }
                    return;
                }
                if (!ReferenceEquals(cm, _cm)) Bind(cm);
                EnsureHooks();
                // A handle whose owner was destroyed must stop counting right away, not
                // at the next player turn: a sold Delay gambit would otherwise leave the
                // longer wait in place for the AI, the indicator and a save made now.
                PruneDead();
            }
            catch (Exception ex)
            {
                var msg = "tick failed: " + ex.Message;
                if (msg != _lastTickError || Time.unscaledTime >= _nextTickErrorLog)
                {
                    _lastTickError = msg;
                    _nextTickErrorLog = Time.unscaledTime + 30f;
                    Log(msg + " (repeats are logged at most every 30s)");
                }
            }
        }

        private static CrumbleManager FindManager()
        {
            try { return SingletonMonoBehaviour<CrumbleManager>.Instance; }
            catch { return null; }
        }

        private static void Bind(CrumbleManager cm)
        {
            _cm = cm;
            _tm = SingletonMonoBehaviour<TurnManager>.Instance;
            _indicator = null;
            _installed = null;
            _cmHandler = MPlayerTurnEffects != null
                ? (Action)Delegate.CreateDelegate(typeof(Action), cm, MPlayerTurnEffects)
                : null;
            if (FTurnToWait != null)
            {
                try { _baseTurnToWait = (int)FTurnToWait.GetValue(cm); } catch { _baseTurnToWait = 3; }
            }
            Log($"bound to CrumbleManager (base wait {_baseTurnToWait} turns).");
            PruneDead();
            ApplyTurnsToWait();
        }

        private static void EnsureHooks()
        {
            if (_cm == null || _cmHandler == null) return;
            if (_tm == null)
            {
                // Bind may have run while the TurnManager was inactive or not yet
                // spawned; keep looking, otherwise the API would stay silently unbound.
                _tm = SingletonMonoBehaviour<TurnManager>.Instance;
                _installed = null;
                if (_tm == null) return;
            }
            var current = _tm.OnPlayerCheckIfCanPlay;
            if (current == null) return;                        // the manager has not subscribed yet
            if (_installed != null && ReferenceEquals(current, _installed)) return;

            var list = current.GetInvocationList();
            int iBefore = -1, iCm = -1, iAfter = -1, nBefore = 0, nAfter = 0;
            for (int i = 0; i < list.Length; i++)
            {
                var d = list[i];
                if (d.Equals(_cmHandler)) iCm = i;
                else if (d.Equals(_before)) { iBefore = i; nBefore++; }
                else if (d.Equals(_after))  { iAfter = i;  nAfter++; }
            }
            if (iCm < 0) return;                                // not subscribed yet; try again next tick
            if (nBefore == 1 && nAfter == 1 && iBefore == iCm - 1 && iAfter == iCm + 1)
            {
                _installed = current;                           // someone appended after us; still fine
                return;
            }

            Action rebuilt = null;
            foreach (var d in list)
            {
                if (d.Equals(_before) || d.Equals(_after)) continue;
                if (d.Equals(_cmHandler))
                {
                    rebuilt += _before;
                    rebuilt += (Action)d;
                    rebuilt += _after;
                }
                else rebuilt += (Action)d;
            }
            _tm.OnPlayerCheckIfCanPlay = rebuilt;
            _installed = rebuilt;
            Log("hooked CrumbleManager.PlayerTurnEffects (before/after).");
        }

        private static void Uninstall()
        {
            if (_tm != null && _tm.OnPlayerCheckIfCanPlay != null)
            {
                var cur = _tm.OnPlayerCheckIfCanPlay;
                cur = (Action)Delegate.Remove(cur, _before);
                cur = (Action)Delegate.Remove(cur, _after);
                _tm.OnPlayerCheckIfCanPlay = cur;
            }
            _installed = null;
        }

        private static void WarnIfGameChanged()
        {
            var missing = new List<string>();
            if (FTurnToWait == null)         missing.Add("m_TurnToWait");
            if (FSkipIncrement == null)      missing.Add("m_SkipIncrement");
            if (FCrumbleTiles == null)       missing.Add("m_CrumbleTiles");
            if (FFellTiles == null)          missing.Add("m_FellTiles");
            if (FParticles == null)          missing.Add("m_PS_CrumbleMode");
            if (MPlayerTurnEffects == null)  missing.Add("PlayerTurnEffects()");
            if (MSelectTilesToShake == null) missing.Add("SelectTilesToShake()");
            if (FIndCounter == null || FIndHintParent == null || FIndHintVisual == null || FIndLightOn == null
                || MIndDestroyChildren == null || MIndCreateChildren == null)
                missing.Add("CrumbleIndicator internals");
            if (missing.Count > 0)
                Log("WARNING: the game no longer has " + string.Join(", ", missing) +
                    " - a Steam update probably changed CrumbleManager. Parts of the API will be inert.");
        }

        // ----- state reads ----------------------------------------------------

        internal static bool IsBound => _enabled && _cm != null && _installed != null;
        internal static CrumbleManager Manager => _cm != null && _cm ? _cm : null;
        internal static int BaseTurnsToWait => _baseTurnToWait;

        internal static int ExtraTurns
        {
            get
            {
                int sum = 0;
                foreach (var h in _handles)
                    if (h.IsActive && !h.OwnerGone && h.Kind == CrumbleHandleKind.Delay) sum += h.Turns;
                return Math.Max(0, Math.Min(Crumble.MaxExtraTurns, sum));
            }
        }

        internal static int WaveBonusTurns
        {
            get
            {
                if (_cm == null) return 0;
                try { return _cm.GetCrumbleTurnCount(); } catch { return 0; }
            }
        }

        internal static bool IsFrozen  => AnyActive(CrumbleHandleKind.Freeze);
        internal static bool IsBlocked => AnyActive(CrumbleHandleKind.Block);

        private static bool AnyActive(CrumbleHandleKind kind)
        {
            foreach (var h in _handles)
                if (h.IsActive && !h.OwnerGone && h.Kind == kind) return true;
            return false;
        }

        internal static IReadOnlyList<CrumbleHandle> Handles
        {
            get { PruneDead(); return new List<CrumbleHandle>(_handles); }
        }

        internal static bool GetSkipIncrement()
        {
            if (_cm == null || FSkipIncrement == null) return false;
            try { return (bool)FSkipIncrement.GetValue(_cm); } catch { return false; }
        }

        internal static void SetSkipIncrement(bool value)
        {
            if (_cm == null || FSkipIncrement == null) return;
            try { FSkipIncrement.SetValue(_cm, value); } catch { }
        }

        internal static IReadOnlyList<TileBehaviour> CopyTiles(bool shaking)
        {
            var result = new List<TileBehaviour>();
            if (_cm == null) return result;
            var f = shaking ? FCrumbleTiles : FFellTiles;
            var list = f?.GetValue(_cm) as List<TileBehaviour>;
            if (shaking && _stepOpen && _realTiles != null) list = _realTiles;
            if (list == null) return result;
            foreach (var t in list) if (t) result.Add(t);
            return result;
        }

        // ----- handles --------------------------------------------------------

        internal static CrumbleHandle Add(CrumbleHandleKind kind, int turns, UnityEngine.Object owner, string label)
        {
            var h = new CrumbleHandle(kind, turns, owner, label);
            _handles.Add(h);
            Log($"{kind}{(kind == CrumbleHandleKind.Delay ? $"(+{h.Turns})" : "")} requested by {label}.");
            HandlesChanged();
            return h;
        }

        internal static void Release(CrumbleHandle h)
        {
            if (_handles.Remove(h)) Log($"{h.Kind} released by {h.Label}.");
            ApplyTurnsToWait();
        }

        internal static void HandlesChanged()
        {
            PruneDead();
            ApplyTurnsToWait();
        }

        private static void PruneDead()
        {
            for (int i = _handles.Count - 1; i >= 0; i--)
            {
                var h = _handles[i];
                if (h.OwnerGone) { Log($"{h.Kind} owner '{h.Label}' was destroyed; releasing."); h.Dispose(); }
            }
        }

        private static void ApplyTurnsToWait()
        {
            if (_cm == null || FTurnToWait == null) return;
            int target = _baseTurnToWait + ExtraTurns;
            try
            {
                int previous = (int)FTurnToWait.GetValue(_cm);
                if (previous == target) return;
                FTurnToWait.SetValue(_cm, target);
                Log($"TurnToWait is now {target} (base {_baseTurnToWait} + {ExtraTurns}).");
                RequestIndicatorRebuild();
                if (target > previous) UndoLoadTimeRelaunch();
            }
            catch (Exception ex) { Log("could not write m_TurnToWait: " + ex.Message); }
        }

        // When a saved run is resumed, LoadManager decides "relaunch crumble mode" 0.3s in,
        // against the base wait, while the gambits that hold Delay handles are only
        // re-created about a second later. So a run saved at 8/15 with a +10 Delay comes
        // back crumbling. This runs whenever the wait grows during a just-loaded stage
        // (PreviousState stays LOAD_RUN until the next state change) and reverts that
        // relaunch if the counter is now below the threshold. A crumble that started
        // naturally cannot be in this situation: its counter is at or past the threshold.
        private static void UndoLoadTimeRelaunch()
        {
            try
            {
                if (_cm == null || !_cm.CrumbleMode) return;
                if (!SingletonMonoBehaviour<GameManager>.IsCreated()) return;
                var gm = SingletonMonoBehaviour<GameManager>.Instance;
                if (gm == null || gm.CurrentState != State.INGAME || gm.PreviousState != State.LOAD_RUN) return;
                int threshold = _cm.TurnToWait + WaveBonusTurns;
                if (_cm.TurnCounter >= threshold) return;
                Log($"undid the load-time crumble relaunch: the countdown is {_cm.TurnCounter}/{threshold} once delays are applied.");
                StopCrumble(resetCounter: false);
            }
            catch (Exception ex) { Log("load-time relaunch check failed: " + ex.Message); }
        }

        // ----- the per-turn hooks ---------------------------------------------

        private static void OnBeforeStepHook()
        {
            try
            {
                PruneDead();
                _stepOpen = true;
                _restoreCrumbleMode = false;
                _restoreCrumblerInGame = false;
                _restoreTurnToWait = false;
                _realTiles = null;

                try { BeforeStep?.Invoke(); }
                catch (Exception ex) { Log("an OnBeforeStep handler threw: " + ex); }

                if (_cm == null) return;

                if (IsFrozen)
                {
                    // No tick, nothing falls, nothing new shakes. Mask the two flags that
                    // start the fall coroutine and hand the coroutine an empty list in
                    // case something else (Mask boss, heavy-landing strain) starts it.
                    SetSkipIncrement(true);
                    if (_cm.CrumbleMode)     { _cm.CrumbleMode = false;     _restoreCrumbleMode = true; }
                    if (_cm.CrumblerInGame)  { _cm.CrumblerInGame = false;  _restoreCrumblerInGame = true; }
                    if (FCrumbleTiles != null)
                    {
                        _realTiles = FCrumbleTiles.GetValue(_cm) as List<TileBehaviour>;
                        if (_realTiles != null) FCrumbleTiles.SetValue(_cm, new List<TileBehaviour>());
                    }
                    // With CrumbleMode masked off, a counter at or past the threshold would
                    // make the game's step run its "crumble starts now" block again every
                    // frozen turn (OnCrumble, influence, banner, and it flips the flag back
                    // on so new tiles get picked). Lift the threshold for the step's duration.
                    if (FTurnToWait != null)
                    {
                        _savedTurnToWait = (int)FTurnToWait.GetValue(_cm);
                        FTurnToWait.SetValue(_cm, int.MaxValue / 4);
                        _restoreTurnToWait = true;
                    }
                }
                else if (IsBlocked && !_cm.CrumbleMode)
                {
                    // Stall the countdown one short of the threshold. Also covers a
                    // counter that is already past it (e.g. after Stop(resetCounter:false)).
                    int stall = Math.Max(0, _cm.TurnToWait + WaveBonusTurns - 1);
                    if (_cm.TurnCounter > stall) SetTurnCounter(stall);
                    if (_cm.TurnCounter >= stall) SetSkipIncrement(true);
                }
            }
            catch (Exception ex) { Log("before-step hook failed: " + ex); }
        }

        private static void OnAfterStepHook()
        {
            try
            {
                if (_cm != null && _stepOpen)
                {
                    if (_restoreTurnToWait && FTurnToWait != null)
                        FTurnToWait.SetValue(_cm, _savedTurnToWait);
                    if (_realTiles != null && FCrumbleTiles != null)
                    {
                        var temp = FCrumbleTiles.GetValue(_cm) as List<TileBehaviour>;
                        FCrumbleTiles.SetValue(_cm, _realTiles);
                        if (temp != null)
                            foreach (var t in temp)
                                if (t && !_realTiles.Contains(t)) _realTiles.Add(t);
                    }
                    if (_restoreCrumblerInGame) _cm.CrumblerInGame = true;
                    if (_restoreCrumbleMode)
                    {
                        // The game's fall coroutine re-checks CrumbleMode one frame later
                        // to decide whether to shake new tiles. Keep it masked until after
                        // that (should anything have flipped it back on during the step,
                        // mask it again), then restore.
                        if (_cm.CrumbleMode) _cm.CrumbleMode = false;
                        int token = ++_restoreToken;
                        _restorePending = true;
                        if (_host != null) _host.StartCoroutine(CoRestoreCrumbleMode(token));
                        else { _cm.CrumbleMode = true; _restorePending = false; }
                    }
                }
                _stepOpen = false;
                _realTiles = null;
                _restoreCrumbleMode = false;
                _restoreCrumblerInGame = false;
                _restoreTurnToWait = false;

                try { AfterStep?.Invoke(); }
                catch (Exception ex) { Log("an OnAfterStep handler threw: " + ex); }
            }
            catch (Exception ex) { Log("after-step hook failed: " + ex); }
        }

        private static IEnumerator CoRestoreCrumbleMode(int token)
        {
            yield return null;
            yield return null;
            if (token != _restoreToken) yield break;
            _restorePending = false;
            if (_cm != null && !_cm.CrumbleMode) _cm.CrumbleMode = true;
        }

        // ----- direct actions -------------------------------------------------

        internal static void SetTurnCounter(int value)
        {
            if (_cm == null) return;
            _cm.TurnCounter = Math.Max(0, value);
            RelightIndicator();
        }

        internal static void StartCrumble(bool fireEvents)
        {
            if (_cm == null) return;
            if (_restorePending || (_stepOpen && _restoreCrumbleMode))
            {
                // Already on, merely masked by a frozen step: just make it visible again.
                _restoreToken++;
                _restorePending = false;
                _restoreCrumbleMode = false;
                _cm.CrumbleMode = true;
                return;
            }
            if (_cm.CrumbleMode) return;
            _restoreToken++;
            _restorePending = false;
            // The game's invariant is CrumbleMode => TurnCounter >= threshold: the save
            // file stores only the counter, and the enemy AI reads urgency from it.
            int threshold = _cm.TurnToWait + WaveBonusTurns;
            if (_cm.TurnCounter < threshold) SetTurnCounter(threshold);
            if (fireEvents)
            {
                try { _cm.OnCrumble?.Invoke(); }
                catch (Exception ex) { Log("an OnCrumble subscriber threw: " + ex.Message); }
                try { SingletonMonoBehaviour<BuildBalanceManager>.Instance?.IncreaseGambitInfluence(Gambit_Focus.CRUMBLE, 0.2f); }
                catch { }
            }
            try { _cm.RelaunchCrumbleMode(); }
            catch (Exception ex) { Log("RelaunchCrumbleMode threw: " + ex.Message); _cm.CrumbleMode = true; }
        }

        internal static void StopCrumble(bool resetCounter)
        {
            if (_cm == null) return;
            _restoreToken++;
            _restorePending = false;
            _cm.CrumbleMode = false;
            try { (FParticles?.GetValue(_cm) as ParticleSystem)?.Stop(); } catch { }
            var list = _stepOpen && _realTiles != null ? _realTiles : FCrumbleTiles?.GetValue(_cm) as List<TileBehaviour>;
            if (list != null)
            {
                foreach (var t in list.ToArray())
                {
                    try { if (t) t.StopCrumble(); } catch { }
                }
                list.Clear();
            }
            if (resetCounter) SetTurnCounter(0);
        }

        internal static void ShakeTile(TileBehaviour tile)
        {
            if (_cm == null || !tile || tile.HasFell || tile.IsShaking) return;
            try { _cm.CrumblerEffect(tile); } catch (Exception ex) { Log("ShakeTile failed: " + ex.Message); }
        }

        internal static void CalmTile(TileBehaviour tile)
        {
            if (_cm == null || !tile) return;
            try { if (tile.IsShaking) tile.StopCrumble(); } catch { }
            var list = FCrumbleTiles?.GetValue(_cm) as List<TileBehaviour>;
            list?.Remove(tile);
            _realTiles?.Remove(tile);
        }

        internal static void RestoreTile(TileBehaviour tile)
        {
            if (_cm == null || !tile || !tile.HasFell) return;
            try { tile.ReAppear(); } catch (Exception ex) { Log("RestoreTile failed: " + ex.Message); }
            var fell = FFellTiles?.GetValue(_cm) as List<TileBehaviour>;
            fell?.Remove(tile);
        }

        internal static void ShakeNextBatch()
        {
            if (_cm == null || MSelectTilesToShake == null) return;
            try { MSelectTilesToShake.Invoke(_cm, null); }
            catch (Exception ex) { Log("SelectTilesToShake threw: " + (ex.InnerException ?? ex).Message); }
        }

        // ----- indicator ------------------------------------------------------

        private static bool InGame
        {
            get
            {
                try
                {
                    return SingletonMonoBehaviour<GameManager>.IsCreated()
                        && SingletonMonoBehaviour<GameManager>.Instance.CurrentState == State.INGAME;
                }
                catch { return false; }
            }
        }

        private static CrumbleIndicator FindIndicator()
        {
            if (_indicator) return _indicator;
            try
            {
                var all = UnityEngine.Object.FindObjectsByType<CrumbleIndicator>(FindObjectsInactive.Include);
                _indicator = all != null && all.Length > 0 ? all[0] : null;
            }
            catch { _indicator = null; }
            return _indicator;
        }

        internal static void RequestIndicatorRebuild()
        {
            if (_host == null || _indicatorRebuildQueued) return;
            _indicatorRebuildQueued = true;
            _host.StartCoroutine(CoRebuildIndicator());
        }

        private static IEnumerator CoRebuildIndicator()
        {
            yield return null;                                  // coalesce bursts of changes
            _indicatorRebuildQueued = false;
            // Outside a stage the game rebuilds the row itself when the board comes up.
            if (_cm == null || !InGame) yield break;
            var ind = FindIndicator();
            if (!ind || MIndDestroyChildren == null || MIndCreateChildren == null) yield break;
            var parent = FIndHintParent?.GetValue(ind) as Transform;
            if (!parent) yield break;

            int want = _cm.TurnToWait + WaveBonusTurns;
            if (parent.childCount != want)
            {
                try { MIndDestroyChildren.Invoke(ind, null); } catch { }
                yield return null;                              // Destroy() lands at end of frame
                if (!ind || _cm == null) yield break;
                try { MIndCreateChildren.Invoke(ind, null); } catch { }
            }
            RelightIndicator();
        }

        // Synchronous rebuild for the one moment a coroutine is not an option (Disable).
        private static void RebuildIndicatorNow()
        {
            var ind = FindIndicator();
            if (!ind || MIndDestroyChildren == null || MIndCreateChildren == null) return;
            try { MIndDestroyChildren.Invoke(ind, null); } catch { }
            try { MIndCreateChildren.Invoke(ind, null); } catch { }
            RelightIndicator();
        }

        private static void RelightIndicator()
        {
            if (_cm == null) return;
            var ind = FindIndicator();
            if (!ind || FIndHintParent == null || FIndLightOn == null) return;
            try
            {
                var parent = FIndHintParent.GetValue(ind) as Transform;
                if (!parent) return;
                var on = (Color)FIndLightOn.GetValue(ind);
                var visual = FIndHintVisual?.GetValue(ind) as Image;
                int n = parent.childCount;
                int counter = Mathf.Clamp(_cm.TurnCounter, 0, n);
                FIndCounter?.SetValue(ind, counter);
                for (int i = 0; i < n; i++)
                {
                    var img = parent.GetChild(i).GetComponent<Image>();
                    if (!img) continue;
                    if (i < counter) img.color = on;
                    else if (visual) img.color = visual.color;
                }
            }
            catch (Exception ex) { Log("indicator relight failed: " + ex.Message); }
        }

        internal static void Log(string message)
        {
            try
            {
                if (Logger != null) Logger(message);
                else Debug.Log("[CrumbleApi] " + message);
            }
            catch { }
        }
    }

    /// <summary>Scene-persistent runner: polls for the manager and hosts the API's coroutines.</summary>
    internal sealed class CrumbleApiHost : MonoBehaviour
    {
        private float _nextTick;

        private void Update()
        {
            if (Time.unscaledTime < _nextTick) return;
            _nextTick = Time.unscaledTime + 0.25f;
            CrumbleCore.Tick();
        }
    }
}
