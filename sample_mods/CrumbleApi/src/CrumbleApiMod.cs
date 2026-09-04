using System;
using System.Collections.Generic;
using System.Text;
using Gambonanza.ModSdk;

namespace Gambonanza.CrumbleApi
{
    /// <summary>
    /// Entry point of the Crumble Control API. A library mod like GambitApi: other mods
    /// reference Gambonanza.CrumbleApi.dll and call <see cref="Crumble"/>. It also adds a
    /// `crumble` family of console commands, both as a cheat and as the quickest way to
    /// try the API before writing a gambit around it. Type `crumble` in the console (F10).
    /// </summary>
    public sealed class CrumbleApiMod : IMod, IModLifecycle
    {
        public static CrumbleApiMod Instance { get; private set; }

        private IModContext _ctx;
        private bool _enabled;

        // The console's own handles, so `crumble freeze off` releases exactly what
        // `crumble freeze on` took and never a gambit's.
        private CrumbleHandle _consoleFreeze;
        private CrumbleHandle _consoleBlock;
        private CrumbleHandle _consoleDelay;

        private static readonly string[] Commands =
        {
            "crumble", "crumble freeze", "crumble block", "crumble delay", "crumble start",
            "crumble stop", "crumble counter", "crumble shake", "crumble calm",
        };

        public void OnLoad(IModContext context)
        {
            Instance = this;
            _ctx = context;
            CrumbleCore.Logger = context.LogLine;
            context.LogLine("loaded. Other mods: reference Gambonanza.CrumbleApi.dll and use Gambonanza.CrumbleApi.Crumble.");
        }

        public void OnEnable()
        {
            if (_enabled) return;
            _enabled = true;
            CrumbleCore.Enable();
            RegisterCommands();
        }

        public void OnDisable()
        {
            if (!_enabled) return;
            _enabled = false;
            _consoleFreeze?.Dispose(); _consoleFreeze = null;
            _consoleBlock?.Dispose();  _consoleBlock = null;
            _consoleDelay?.Dispose();  _consoleDelay = null;
            var console = _ctx?.Console;
            if (console != null) foreach (var c in Commands) console.UnregisterCommand(c);
            CrumbleCore.Disable();
            _ctx?.LogLine("disabled; game crumble restored.");
        }

        // ----- console --------------------------------------------------------

        private void RegisterCommands()
        {
            var console = _ctx?.Console;
            if (console == null) return;

            console.RegisterCommand("crumble", "crumble mode status and API handles (see: crumble freeze|block|delay|start|stop|counter|shake|calm)",
                args =>
                {
                    // Longest-first matching routes any unknown subcommand here with it as args[0].
                    if (args.Length > 0)
                    {
                        console.PrintError($"unknown crumble command '{args[0]}'. Try: freeze | block | delay <n> | start | stop | counter <n> | shake | calm");
                        return;
                    }
                    PrintStatus(console);
                },
                (args, i) => i == 0 ? new[] { "freeze", "block", "delay", "start", "stop", "counter", "shake", "calm" } : null);

            console.RegisterCommand("crumble freeze", "pause the crumble (no tick, nothing falls or shakes): crumble freeze [on|off]",
                args => Toggle(console, args, "freeze", ref _consoleFreeze, () => Crumble.Freeze(null, "console")),
                CompleteOnOff);

            console.RegisterCommand("crumble block", "stop crumble mode from ever starting: crumble block [on|off]",
                args => Toggle(console, args, "block", ref _consoleBlock, () => Crumble.Block(null, "console")),
                CompleteOnOff);

            console.RegisterCommand("crumble delay", "set the console's extra countdown turns (0 clears; gambits' delays stack on top): crumble delay 10",
                args =>
                {
                    if (args.Length < 1 || !int.TryParse(args[0], out int n) || n < 0 || n > Crumble.MaxExtraTurns)
                    {
                        console.PrintError($"usage: crumble delay <0-{Crumble.MaxExtraTurns}>");
                        return;
                    }
                    if (n == 0)
                    {
                        _consoleDelay?.Dispose(); _consoleDelay = null;
                        console.PrintInfo("console delay cleared.");
                    }
                    else
                    {
                        if (_consoleDelay == null || !_consoleDelay.IsActive) _consoleDelay = Crumble.Delay(n, null, "console");
                        else _consoleDelay.Turns = n;
                        console.PrintInfo($"console delay = {_consoleDelay.Turns} turn(s).");
                    }
                    PrintCountdown(console);
                });

            console.RegisterCommand("crumble start", "begin crumble mode now, fanfare included (crumble start quiet: no OnCrumble/influence)",
                args =>
                {
                    if (!RequireBound(console)) return;
                    bool quiet = args.Length > 0 && args[0].Equals("quiet", StringComparison.OrdinalIgnoreCase);
                    if (args.Length > 0 && !quiet) { console.PrintError("usage: crumble start [quiet]"); return; }
                    if (Crumble.IsActive) { console.PrintWarn("crumble mode is already on."); return; }
                    Crumble.Start(fireEvents: !quiet);
                    console.PrintInfo("crumble mode started" + (quiet ? " (quiet)." : "."));
                },
                (args, i) => i == 0 ? new[] { "quiet" } : null);

            console.RegisterCommand("crumble stop", "end crumble mode, settle shaking tiles, restart the countdown (crumble stop keep: keep the counter)",
                args =>
                {
                    if (!RequireBound(console)) return;
                    bool keep = args.Length > 0 && args[0].Equals("keep", StringComparison.OrdinalIgnoreCase);
                    if (args.Length > 0 && !keep) { console.PrintError("usage: crumble stop [keep]"); return; }
                    int shaking = Crumble.ShakingTiles.Count;
                    Crumble.Stop(resetCounter: !keep);
                    console.PrintInfo($"crumble mode stopped; {shaking} shaking tile(s) settled" + (keep ? "; counter kept." : "; counter reset to 0."));
                },
                (args, i) => i == 0 ? new[] { "keep" } : null);

            console.RegisterCommand("crumble counter", "set the countdown counter: crumble counter 0",
                args =>
                {
                    if (!RequireBound(console)) return;
                    if (args.Length < 1 || !int.TryParse(args[0], out int n) || n < 0)
                    {
                        console.PrintError("usage: crumble counter <n>");
                        return;
                    }
                    // Anything at the threshold starts the crumble on the next step, and an
                    // int.MaxValue counter would wrap negative on the game's ++.
                    int max = Crumble.Threshold;
                    if (n > max) { console.PrintWarn($"{n} capped at the threshold ({max})."); n = max; }
                    Crumble.TurnCounter = n;
                    PrintCountdown(console);
                });

            console.RegisterCommand("crumble shake", "shake the game's next batch of tiles now (they fall on the next step while crumble mode is on)",
                _ =>
                {
                    if (!RequireBound(console)) return;
                    int before = Crumble.ShakingTiles.Count;
                    Crumble.ShakeNextBatch();
                    console.PrintInfo($"{Crumble.ShakingTiles.Count - before} new tile(s) shaking; {Crumble.ShakingTiles.Count} total." +
                                      (Crumble.IsActive ? "" : " Crumble mode is off, so they keep shaking until it starts (or 'crumble calm')."));
                });

            console.RegisterCommand("crumble calm", "settle every shaking tile without ending crumble mode",
                _ =>
                {
                    if (!RequireBound(console)) return;
                    var tiles = Crumble.ShakingTiles;
                    foreach (var t in tiles) Crumble.CalmTile(t);
                    console.PrintInfo($"{tiles.Count} tile(s) settled.");
                });
        }

        private static IEnumerable<string> CompleteOnOff(string[] args, int argIndex)
            => argIndex == 0 ? new[] { "on", "off" } : null;

        private bool RequireBound(IConsoleApi console)
        {
            if (Crumble.IsBound) return true;
            console.PrintWarn("CrumbleApi is not bound to the game yet - start or load a run first.");
            return false;
        }

        private void Toggle(IConsoleApi console, string[] args, string what, ref CrumbleHandle handle, Func<CrumbleHandle> take)
        {
            bool currently = handle != null && handle.IsActive;
            bool want;
            if (args.Length == 0) want = !currently;
            else if (args[0].Equals("on", StringComparison.OrdinalIgnoreCase)) want = true;
            else if (args[0].Equals("off", StringComparison.OrdinalIgnoreCase)) want = false;
            else { console.PrintError($"usage: crumble {what} [on|off]"); return; }

            if (want && !currently) handle = take();
            else if (!want && currently) { handle.Dispose(); handle = null; }

            string state = want ? "on" : "off";
            string others = what == "freeze"
                ? (Crumble.IsFrozen != want ? " (other holders keep it frozen)" : "")
                : (Crumble.IsBlocked != want ? " (other holders keep it blocked)" : "");
            console.PrintInfo($"console {what}: {state}{others}.");
            if (!Crumble.IsBound) console.PrintWarn("(takes effect once a run is in progress)");
        }

        private void PrintCountdown(IConsoleApi console)
        {
            if (!Crumble.IsBound) { console.PrintInfo("countdown: not bound yet."); return; }
            string tail = Crumble.IsActive ? "crumble mode is on" : $"{Crumble.TurnsUntilCrumble} turn(s) to go";
            console.PrintInfo($"countdown: {Crumble.TurnCounter}/{Crumble.Threshold} " +
                              $"(wait {Crumble.TurnsToWait} = base {Crumble.BaseTurnsToWait} + extra {Crumble.ExtraTurns}, " +
                              $"wave bonus {Crumble.WaveBonusTurns}; {tail}).");
        }

        private void PrintStatus(IConsoleApi console)
        {
            if (!Crumble.IsBound)
            {
                console.PrintInfo(Crumble.Manager != null
                    ? "CrumbleApi: found the game's CrumbleManager, waiting for it to subscribe its per-turn step (start or load a run)."
                    : "CrumbleApi: loaded, waiting for the game's CrumbleManager (start or load a run).");
            }
            else
            {
                console.PrintInfo($"crumble mode: {(Crumble.IsActive ? "ON" : "off")}" +
                                  $"{(Crumble.IsFrozen ? "  [FROZEN]" : "")}{(Crumble.IsBlocked ? "  [BLOCKED]" : "")}" +
                                  $"{(Crumble.CrumblerInGame ? "  (Crumbler enemy on board)" : "")}");
                PrintCountdown(console);
                console.PrintInfo($"tiles: {Crumble.ShakingTiles.Count} shaking, {Crumble.FallenTiles.Count} fallen" +
                                  (Crumble.SkipNextIncrement ? "; next tick will be skipped" : ""));
            }

            var sb = new StringBuilder();
            foreach (var h in Crumble.Handles)
            {
                if (!h.IsActive) continue;
                sb.Append("  ").Append(h.Kind);
                if (h.Kind == CrumbleHandleKind.Delay) sb.Append("(+").Append(h.Turns).Append(')');
                sb.Append(" by ").Append(h.Label);
            }
            console.PrintInfo(sb.Length == 0
                ? "handles: none. Try: crumble freeze | crumble block | crumble delay 10"
                : "handles:" + sb);
        }
    }
}
