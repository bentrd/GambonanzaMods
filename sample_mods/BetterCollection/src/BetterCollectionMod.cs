using System;
using Gambonanza.ModSdk;
using UnityEngine;

namespace Gambonanza.BetterCollection
{
    /// <summary>
    /// Makes the gambit collection screen smooth.
    ///
    /// The screen's cost is almost entirely stacked UI mesh effects: vanilla puts up
    /// to four UnityEngine.UI.Outline components plus a Shadow on a single graphic,
    /// and because each one re-processes the previous one's output they multiply
    /// (x5 each, x2 for Shadow). The page arrows land at x1250 - a 6-vertex quad
    /// rebuilds as 7,500 vertices, and every layout pass pushes that through
    /// List&lt;UIVertex&gt; copies. Measured with the CollectionProfiler sweep, removing
    /// them was the only change that flattened frame time.
    ///
    /// This keeps one outline per colour instead of removing them, so the screen
    /// still looks like itself.
    /// </summary>
    public sealed class BetterCollectionMod : IMod, IModLifecycle
    {
        private IModContext _context;
        private BetterCollectionRunner _runner;
        private BetterCollectionConfig _config;

        public void OnLoad(IModContext context)
        {
            _context = context;
            _config = BetterCollectionConfig.Load(context?.ModDirectory, Log);
            RegisterCommands();
            Log("loaded.");
        }

        public void OnEnable()
        {
            if (_runner != null) return;
            try
            {
                var go = new GameObject("__BetterCollectionRunner");
                UnityEngine.Object.DontDestroyOnLoad(go);
                go.hideFlags = HideFlags.HideAndDontSave;
                _runner = go.AddComponent<BetterCollectionRunner>();
                _runner.Bind(_config, Log);
            }
            catch (Exception ex)
            {
                Log("enable failed: " + ex);
            }
        }

        public void OnDisable()
        {
            try
            {
                if (_runner != null)
                {
                    _runner.TearDown();   // puts every outline back exactly as it was
                    UnityEngine.Object.Destroy(_runner.gameObject);
                    _runner = null;
                }
                Log("disabled.");
            }
            catch (Exception ex)
            {
                Log("disable failed: " + ex);
            }
        }

        private void RegisterCommands()
        {
            var console = _context?.Console;
            if (console == null) return;

            console.RegisterCommand("collection", "collection [outlines <0-4>] - collection perf tuning",
                args =>
                {
                    if (args.Length >= 2 && args[0].Equals("outlines", StringComparison.OrdinalIgnoreCase))
                    {
                        if (!int.TryParse(args[1], out int n) || n < 0 || n > 4)
                        {
                            console.PrintError("usage: collection outlines <0-4>");
                            return;
                        }
                        _config.maxOutlines = n;
                        _config.Save(_context?.ModDirectory, Log);
                        if (_runner != null && _runner.IsBound)
                        {
                            _runner.Reapply();
                            console.PrintInfo($"outline cap = {n}. Chains collapsed: {_runner.ChainsCollapsed}, " +
                                              $"image vertices now {_runner.CurrentVerts()}.");
                        }
                        else
                        {
                            console.PrintInfo($"outline cap = {n} (applies once the collection screen is found).");
                        }
                        return;
                    }

                    if (_runner == null || !_runner.IsBound)
                    {
                        console.PrintWarn("not bound yet - open the collection once.");
                        return;
                    }
                    console.PrintInfo($"BetterCollection: {_runner.ScreenCount} screen(s), " +
                                      $"outline cap {_config.maxOutlines}, " +
                                      $"{_runner.ChainsCollapsed} chains collapsed, " +
                                      $"{_runner.EffectsDisabled} effect components off.");
                    console.PrintInfo($"  image vertices {_runner.VertsBefore} -> {_runner.VertsAfter} " +
                                      $"(now {_runner.CurrentVerts()} across bound screens).");
                },
                (args, argIndex) => argIndex == 0
                    ? new[] { "outlines" }
                    : (argIndex == 1 ? new[] { "0", "1", "2", "3", "4" } : null));
        }

        private void Log(string message) => _context?.LogLine(message);
    }
}
