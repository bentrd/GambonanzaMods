using System;
using System.Collections.Generic;
using System.Linq;
using Gambonanza.ModSdk;

namespace Gambonanza.StrainApi
{
    /// <summary>
    /// Entry point of the Strain Creation API. A library mod like GambitApi and CrumbleApi:
    /// other mods reference Gambonanza.StrainApi.dll, register strains with
    /// <see cref="StrainBuilder"/> and ask about them through <see cref="Strains"/>. It
    /// puts modded strains on pages of the game's own Custom strain screen, and adds a
    /// `strain` family of console commands - the quickest way to try a strain while
    /// writing it.
    /// </summary>
    public sealed class StrainApiMod : IMod, IModLifecycle
    {
        public static StrainApiMod Instance { get; private set; }

        private IModContext _ctx;
        private bool _enabled;

        private static readonly string[] Commands =
        {
            "strain", "strain list", "strain info", "strain on", "strain off",
            "strain apply", "strain remove",
        };

        public void OnLoad(IModContext context)
        {
            Instance = this;
            _ctx = context;
            StrainCore.Logger = context.LogLine;
            StrainStore.Load();
            context.LogLine("loaded. Other mods: reference Gambonanza.StrainApi.dll and use StrainBuilder / Strains.");
        }

        public void OnEnable()
        {
            if (_enabled) return;
            _enabled = true;
            StrainCore.Enable();
            RegisterCommands();
        }

        public void OnDisable()
        {
            if (!_enabled) return;
            _enabled = false;
            var console = _ctx?.Console;
            if (console != null) foreach (var c in Commands) console.UnregisterCommand(c);
            StrainCore.Disable();
            _ctx?.LogLine("disabled; mod strains are off until it is enabled again.");
        }

        // ----- console --------------------------------------------------------

        private void RegisterCommands()
        {
            var console = _ctx?.Console;
            if (console == null) return;

            console.RegisterCommand("strain", "mod strains: what is picked and what is on this run (see: strain list|info|on|off|apply|remove)",
                args =>
                {
                    // Longest-first matching routes any unknown subcommand here with it as args[0].
                    if (args.Length > 0)
                    {
                        console.PrintError($"unknown strain command '{args[0]}'. Try: list | info <id> | on <id> | off <id|all> | apply <id> | remove <id>");
                        return;
                    }
                    PrintStatus(console);
                },
                (args, i) => i == 0 ? new[] { "list", "info", "on", "off", "apply", "remove" } : null);

            console.RegisterCommand("strain list", "every registered mod strain, with what is picked and what is on this run",
                _ => PrintList(console));

            console.RegisterCommand("strain info", "full description of a strain: strain info <id>",
                args =>
                {
                    var def = Resolve(console, args, "strain info <id>");
                    if (def == null) return;
                    console.PrintInfo($"{def.Name} ({def.Id}) - heat {def.Heat}, from {def.Source}");
                    console.PrintInfo("  " + (string.IsNullOrEmpty(def.Description) ? "(no description)" : StrainRegistry.PlainText(def.Description)));
                    if (def.IncompatibleWith.Count > 0) console.PrintInfo("  incompatible with: " + string.Join(", ", def.IncompatibleWith));
                    console.PrintInfo($"  picked for next run: {(Strains.IsSelected(def.Id) ? "yes" : "no")} | on this run: {(Strains.IsActive(def.Id) ? "yes" : "no")}");
                },
                CompleteIds);

            console.RegisterCommand("strain on", "pick a strain for your next Custom run: strain on <id>",
                args =>
                {
                    var def = Resolve(console, args, "strain on <id>");
                    if (def == null) return;
                    var dropped = Strains.Selected.Where(s => s.ConflictsWith(def)).Select(s => s.Id).ToList();
                    Strains.SetSelected(def.Id, true);
                    console.PrintInfo($"'{def.Id}' picked for your next Custom run." +
                                      (dropped.Count > 0 ? $" Unpicked (incompatible): {string.Join(", ", dropped)}." : ""));
                    if (Strains.IsRunInProgress && !Strains.IsActive(def.Id))
                        console.PrintInfo($"(this run keeps its own strains; 'strain apply {def.Id}' puts it on now)");
                },
                CompleteIds);

            console.RegisterCommand("strain off", "unpick a strain for your next Custom run: strain off <id|all>",
                args =>
                {
                    if (args.Length == 1 && args[0].Equals("all", StringComparison.OrdinalIgnoreCase))
                    {
                        console.PrintInfo($"unpicked {Strains.ClearSelection()} strain(s).");
                        return;
                    }
                    var def = Resolve(console, args, "strain off <id|all>");
                    if (def == null) return;
                    Strains.SetSelected(def.Id, false);
                    console.PrintInfo($"'{def.Id}' unpicked for your next Custom run.");
                },
                (args, i) => i == 0 ? new[] { "all" }.Concat(Ids()) : null);

            console.RegisterCommand("strain apply", "put a strain on the run in progress, now (testing/cheat): strain apply <id>",
                args =>
                {
                    var def = Resolve(console, args, "strain apply <id>");
                    if (def == null) return;
                    if (Strains.Apply(def.Id, out var error)) console.PrintInfo($"'{def.Id}' is on this run.");
                    else console.PrintError(error);
                },
                CompleteIds);

            console.RegisterCommand("strain remove", "take a strain off the run in progress, now: strain remove <id>",
                args =>
                {
                    var def = Resolve(console, args, "strain remove <id>");
                    if (def == null) return;
                    if (Strains.Remove(def.Id, out var error)) console.PrintInfo($"'{def.Id}' is off this run.");
                    else console.PrintError(error);
                },
                (args, i) => i == 0 ? Strains.Active.Select(d => d.Id) : null);

        }

        private static StrainDefinition Resolve(IConsoleApi console, string[] args, string usage)
        {
            if (args.Length == 0) { console.PrintError("usage: " + usage); return null; }
            var query = string.Join(" ", args);
            var def = StrainRegistry.Find(query);
            if (def == null) console.PrintError($"no strain '{query}'. Try: strain list");
            return def;
        }

        private static IEnumerable<string> Ids() => Strains.All.Select(d => d.Id);

        private static IEnumerable<string> CompleteIds(string[] args, int argIndex) => argIndex == 0 ? Ids() : null;

        private static void PrintStatus(IConsoleApi console)
        {
            int n = Strains.All.Count;
            int mods = Strains.All.Select(d => d.Source).Distinct().Count();
            console.PrintInfo(n == 0
                ? "StrainApi: no mod has registered a strain yet."
                : $"StrainApi: {n} strain(s) from {mods} mod(s). 'strain list' shows them.");

            var picked = Strains.Selected;
            console.PrintInfo("next Custom run: " + (picked.Count == 0 ? "none picked" : string.Join(", ", picked.Select(d => d.Id))) +
                              "  (New Run > Custom > the arrows by STRAINS, or 'strain on|off <id>')");

            if (!Strains.IsBound)
                console.PrintInfo("this run: not following the game yet (it binds a moment after boot).");
            else if (!Strains.IsRunInProgress)
                console.PrintInfo($"this run: no run in progress (game state {StrainCore.GameState}).");
            else
            {
                var active = Strains.Active;
                console.PrintInfo("this run: " + (active.Count == 0 ? "no mod strains" : string.Join(", ", active.Select(d => d.Id))) +
                                  (Strains.IsGameInProgress ? "  - a game is being played" : "") +
                                  $"  (game state {StrainCore.GameState})");
                var vanilla = Strains.VanillaActive;
                console.PrintInfo("the game's own strains on it: " + (vanilla.Count == 0 ? "none" : string.Join(", ", vanilla)));
            }
        }

        private static void PrintList(IConsoleApi console)
        {
            var all = Strains.All;
            if (all.Count == 0) { console.PrintInfo("no mod has registered a strain yet."); return; }
            foreach (var def in all)
            {
                var marks = (Strains.IsSelected(def.Id) ? "[picked]" : "") + (Strains.IsActive(def.Id) ? "[on this run]" : "");
                console.PrintInfo($"  {def.Id} - {def.Name} (heat {def.Heat}) {marks}".TrimEnd());
            }
            console.PrintInfo("'strain info <id>' for details, 'strain on <id>' to pick one.");
        }
    }
}
