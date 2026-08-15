using System;
using System.Collections.Generic;
using Blukulele.CHE;
using UnityEngine;

namespace Gambonanza.BetterCollection
{
    /// <summary>
    /// Finds the collection UI and collapses its mesh-effect stacks.
    ///
    /// Deliberately does almost nothing per frame: the collapse is applied once the
    /// canvas is found - while it is still inactive, so there is no visible pop - and
    /// re-applied when a screen opens only to catch UI other mods may have added.
    /// Update() is a single activeInHierarchy check.
    /// </summary>
    public sealed class BetterCollectionRunner : MonoBehaviour
    {
        private readonly OutlineCollapser _collapser = new OutlineCollapser();
        private readonly List<GameObject> _roots = new List<GameObject>();
        private BetterCollectionConfig _config;
        private Action<string> _log;
        private bool _bound;
        private bool _wasOpen;
        private float _nextBindAttempt;

        public bool IsBound => _bound;
        public int ChainsCollapsed => _collapser.ChainsCollapsed;
        public int EffectsDisabled => _collapser.EffectsDisabled;
        public int VertsBefore => _collapser.VertsBefore;
        public int VertsAfter => _collapser.VertsAfter;

        public void Bind(BetterCollectionConfig config, Action<string> log)
        {
            _config = config;
            _log = log;
        }

        private void Update()
        {
            if (!_bound)
            {
                // Resources.FindObjectsOfTypeAll walks every loaded object (~42k here),
                // so it gets a throttle rather than running once a frame until the
                // canvas shows up. Binding normally succeeds on the first attempt.
                if (Time.unscaledTime < _nextBindAttempt) return;
                _nextBindAttempt = Time.unscaledTime + 1f;
                TryBind();
                return;
            }

            bool open = false;
            for (int i = 0; i < _roots.Count; i++)
                if (_roots[i] != null && _roots[i].activeInHierarchy) { open = true; break; }

            // Re-apply on open: cheap (a skip-list lookup per graphic) and it catches
            // anything another mod added to the screen since we last looked.
            if (open && !_wasOpen) ApplyAll();
            _wasOpen = open;
        }

        private void TryBind()
        {
            foreach (var c in Resources.FindObjectsOfTypeAll<CollectionCanvas>())
            {
                if (c == null || !c.gameObject.scene.IsValid()) continue;
                if (!_roots.Contains(c.gameObject)) _roots.Add(c.gameObject);
            }

            if (_config != null && _config.alsoRunInfoScreen)
            {
                // The run-info screen embeds the same Gambit_Slide prefab - same arrows,
                // same x1250 stacks - and it is on screen during actual gameplay.
                foreach (var slide in Resources.FindObjectsOfTypeAll<GambitCollectionSlide>())
                {
                    if (slide == null || !slide.gameObject.scene.IsValid()) continue;
                    var canvas = slide.GetComponentInParent<Canvas>(true);
                    var root = canvas != null ? canvas.gameObject : slide.gameObject;
                    if (!_roots.Contains(root)) _roots.Add(root);
                }
            }

            if (_roots.Count == 0) return;

            _bound = true;
            ApplyAll();
            _log?.Invoke($"collapsed {ChainsCollapsed} stacked effect chains " +
                         $"({EffectsDisabled} components off) across {_roots.Count} screen(s); " +
                         $"image vertices {VertsBefore} -> {VertsAfter}.");
        }

        private void ApplyAll()
        {
            if (_config == null) return;
            for (int i = 0; i < _roots.Count; i++)
            {
                if (_roots[i] == null) continue;
                try
                {
                    _collapser.Apply(_roots[i], _config.maxOutlines, _config.compensateThickness);
                }
                catch (Exception ex)
                {
                    _log?.Invoke("apply failed: " + ex.Message);
                }
            }
        }

        /// <summary>Re-run with a different outline cap, live. Used by the console command.</summary>
        public void Reapply()
        {
            _collapser.Revert();
            ApplyAll();
        }

        /// <summary>Vertex totals for the bound screens as they currently stand.</summary>
        public int CurrentVerts()
        {
            int n = 0;
            for (int i = 0; i < _roots.Count; i++)
                if (_roots[i] != null) n += OutlineCollapser.CountVerts(_roots[i]);
            return n;
        }

        public int ScreenCount => _roots.Count;

        public void TearDown()
        {
            try { _collapser.Revert(); }
            catch (Exception ex) { _log?.Invoke("revert failed: " + ex.Message); }
        }
    }
}
