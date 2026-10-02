using System;
using UnityEngine;

namespace Gambonanza.ModSdk
{
    /// <summary>
    /// Per-mod runtime context, supplied by ModHost during OnLoad.
    /// Use the events to subscribe to game lifecycle hooks the patcher routes through ModHost.
    /// Optional defeat interception is available by casting to IModLossHooks.
    /// </summary>
    public interface IModContext
    {
        /// <summary>The mod's id from mod.json.</summary>
        string ModId { get; }

        /// <summary>Absolute path to the mod's folder under Mods/.</summary>
        string ModDirectory { get; }

        /// <summary>Logs to Unity's Debug.Log with a [ModId] prefix.</summary>
        void LogLine(string message);

        /// <summary>
        /// In-game developer console. Always non-null - the console is created
        /// before any mod's OnLoad runs. Use it to print info and register custom
        /// commands.
        /// </summary>
        IConsoleApi Console { get; }

        /// <summary>Returns true while the configured keybind is held down.</summary>
        bool IsKeybindHeld(string name);

        /// <summary>Returns true on the frame the configured keybind is pressed.</summary>
        bool WasKeybindPressed(string name);

        /// <summary>Returns the configured keybind text, or "unset".</summary>
        string GetKeybind(string name);

        /// <summary>
        /// Fires every time SettingsCanvas.OnEnable runs. Argument is the SettingsCanvas instance.
        /// Subscribers should be idempotent - the modal may be opened many times in one session.
        /// </summary>
        event Action<MonoBehaviour> OnSettingsOpened;
    }
}
