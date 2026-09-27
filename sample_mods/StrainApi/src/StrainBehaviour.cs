using System;
using UnityEngine;

namespace Gambonanza.StrainApi
{
    /// <summary>
    /// Base class for a strain's runtime logic. Pass your subclass to
    /// <see cref="StrainBuilder.WithBehaviour{T}"/>.
    ///
    /// One instance lives on its own hidden GameObject for exactly as long as the strain
    /// is on the run being played: it is created when a run starts with the strain (or a
    /// saved run with it is continued) and destroyed when the player leaves that run.
    /// So the ordinary Unity lifecycle is the strain's lifecycle - set things up in
    /// <c>Awake</c>/<c>Start</c>, undo them in <c>OnDestroy</c>, poll in <c>Update</c> -
    /// and anything that takes an owner (a CrumbleApi handle, say) can take <c>this</c>.
    /// <see cref="Definition"/> is already set by the time <c>Awake</c> runs.
    ///
    /// The overridable hooks cover the moments a strain usually cares about. They fire
    /// when something actually starts, never when Continue drops the player back into
    /// the middle of it: a continued run gets no OnRunStarted, and a run continued in the
    /// middle of a game or the shop gets no OnGameStarted or OnShopOpened (it does get
    /// OnGameEnded when that game ends). Awake/Start run either way, so live setup goes
    /// there - <see cref="Strains.IsGameInProgress"/> tells you whether you came back
    /// mid-game. Each hook runs before the builder delegate of the same name, and an
    /// exception in one is logged and contained: it never reaches the game or another
    /// strain.
    /// </summary>
    public abstract class StrainBehaviour : MonoBehaviour
    {
        /// <summary>The strain this instance runs for.</summary>
        public StrainDefinition Definition { get; private set; }

        /// <summary>Shorthand for <c>Definition.Id</c>.</summary>
        public string Id => Definition?.Id;

        /// <summary>
        /// A new run just started with this strain on it. Once per run - not when a saved
        /// run is continued - so it is the place for one-time changes to the run itself
        /// (money, pieces, gambits), which the game then saves with the run.
        /// </summary>
        protected virtual void OnRunStarted() { }

        /// <summary>
        /// A game (one match against the opponent) just began: pieces are placed and play
        /// starts. Once per game - a run continued mid-game does not get it again.
        /// </summary>
        protected virtual void OnGameStarted() { }

        /// <summary>The start of each of the player's turns during a game.</summary>
        protected virtual void OnPlayerTurn() { }

        /// <summary>
        /// The game is over: the player won it, or left the run in the middle of it.
        /// </summary>
        protected virtual void OnGameEnded() { }

        /// <summary>The shop just opened after a game (not when a run is continued in the shop).</summary>
        protected virtual void OnShopOpened() { }

        /// <summary>Writes <c>[StrainApi] [&lt;id&gt;] message</c> to the game log.</summary>
        protected void Log(string message) => StrainCore.Log($"[{Id}] {message}");

        internal void Bind(StrainDefinition definition) => Definition = definition;

        internal void Raise(StrainEvent evt)
        {
            try
            {
                switch (evt)
                {
                    case StrainEvent.RunStarted:  OnRunStarted();  break;
                    case StrainEvent.GameStarted: OnGameStarted(); break;
                    case StrainEvent.PlayerTurn:  OnPlayerTurn();  break;
                    case StrainEvent.GameEnded:   OnGameEnded();   break;
                    case StrainEvent.ShopOpened:  OnShopOpened();  break;
                }
            }
            catch (Exception ex) { StrainCore.Log($"[{Id}] {evt} override threw: {ex}"); }

            RunHook(DelegateFor(evt), evt);
        }

        internal void RunHook(Action<StrainBehaviour> hook, StrainEvent evt)
        {
            if (hook == null) return;
            try { hook(this); }
            catch (Exception ex) { StrainCore.Log($"[{Id}] {evt} hook threw: {ex}"); }
        }

        private Action<StrainBehaviour> DelegateFor(StrainEvent evt)
        {
            var d = Definition;
            if (d == null) return null;
            switch (evt)
            {
                case StrainEvent.RunStarted:  return d.RunStarted;
                case StrainEvent.GameStarted: return d.GameStarted;
                case StrainEvent.PlayerTurn:  return d.PlayerTurn;
                case StrainEvent.GameEnded:   return d.GameEnded;
                case StrainEvent.ShopOpened:  return d.ShopOpened;
                default:                      return null;
            }
        }
    }

    /// <summary>The behaviour spawned for a strain that only uses builder delegates.</summary>
    internal sealed class DelegateStrainBehaviour : StrainBehaviour { }

    internal enum StrainEvent
    {
        Activated,
        RunStarted,
        GameStarted,
        PlayerTurn,
        GameEnded,
        ShopOpened,
        Deactivated,
    }
}
