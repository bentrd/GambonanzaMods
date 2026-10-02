using System;
using UnityEngine;

namespace Gambonanza.ModSdk
{
    /// <summary>
    /// Optional capability of the context supplied to IMod.OnLoad. Cast the context
    /// to this interface to intercept defeat without changing IModContext's contract.
    /// </summary>
    public interface IModLossHooks
    {
        /// <summary>
        /// Fires at the start of GameManager.Lose, before loss statistics, the LOSE
        /// state transition and run-save deletion. Argument is the GameManager instance.
        /// Return true to cancel that call, or false to let other handlers and vanilla
        /// defeat run. The first true stops dispatch, so only one mod claims a rescue.
        /// A throwing handler is logged and treated as false.
        ///
        /// Capture, falling tiles and UI preparation may already have happened. The
        /// handler owns any replacement behavior, cleanup and persistent charge state;
        /// cancelling does not award victory or restore pieces. Future delayed Lose
        /// calls fire this hook again. Recursive Lose on the same instance during
        /// dispatch is suppressed. Only enabled mods receive the hook.
        /// </summary>
        event Func<MonoBehaviour, bool> OnBeforeLose;
    }
}
