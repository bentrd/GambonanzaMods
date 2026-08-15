using System;
using Gambonanza.ModSdk;
using UnityEngine;

namespace Gambonanza.CollectionProfiler
{
    /// <summary>
    /// Diagnostic-only mod. Measures why the gambit collection screen is slow by
    /// running an automatic A/B sweep while the collection is open: it disables one
    /// suspected cause at a time, samples frame times for a few seconds, then moves
    /// on. On quit it writes a ranked report.
    ///
    /// Nothing here is a fix - every change is reverted between phases and on unload.
    /// </summary>
    public sealed class CollectionProfilerMod : IMod, IModLifecycle
    {
        private IModContext _context;
        private CollectionProfilerRunner _runner;

        public void OnLoad(IModContext context)
        {
            _context = context;
            _context?.LogLine("loaded - open the collection and browse for ~30s.");
        }

        public void OnEnable()
        {
            if (_runner != null) return;
            try
            {
                var go = new GameObject("__CollectionProfilerRunner");
                UnityEngine.Object.DontDestroyOnLoad(go);
                go.hideFlags = HideFlags.HideAndDontSave;
                _runner = go.AddComponent<CollectionProfilerRunner>();
                _runner.Bind(_context);
                _context?.LogLine("enabled.");
            }
            catch (Exception ex)
            {
                _context?.LogLine("enable failed: " + ex);
            }
        }

        public void OnDisable()
        {
            try
            {
                if (_runner != null)
                {
                    _runner.TearDown();
                    UnityEngine.Object.Destroy(_runner.gameObject);
                    _runner = null;
                }
                _context?.LogLine("disabled.");
            }
            catch (Exception ex)
            {
                _context?.LogLine("disable failed: " + ex);
            }
        }
    }
}
