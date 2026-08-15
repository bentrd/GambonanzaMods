using System;
using System.Collections.Generic;
using System.Reflection;
using Blukulele.CHE;
using DG.Tweening;
using UnityEngine;
using UnityEngine.UI;

namespace Gambonanza.CollectionProfiler
{
    /// <summary>One knob per suspected cause. Combined into configs by the sweep.</summary>
    [Flags]
    public enum Knob
    {
        None = 0,
        NoIdleRotation = 1 << 0,  // GambitLibraryIconBehaviour.Update writes transform.rotation every frame
        NoUifxFilters = 1 << 1,  // ChocDino.UIFX filters re-render whenever their card moves
        NoMeshEffects = 1 << 2,  // stacked Outline(x5)/Shadow(x2) multiply vertices
        NoAutoLayout = 1 << 3,  // AutoLayoutRebuilder does 2x scene-global Canvas.ForceUpdateCanvases()
        NoGridTween = 1 << 4,  // GridLayoutGroup.spacing tween re-lays-out every frame for 0.45s
        CardSubCanvas = 1 << 5,  // split the 430-renderer batch: one Canvas per card
        NoModPagination = 1 << 6,  // GambitApi's CollectionPaginationPatch: reflection in LateUpdate
    }

    public sealed class ExperimentConfig
    {
        public readonly string Name;
        public readonly Knob Knobs;
        public readonly FrameStats Steady = new FrameStats();
        public readonly FrameStats Burst = new FrameStats();

        public ExperimentConfig(string name, Knob knobs) { Name = name; Knobs = knobs; }
    }

    /// <summary>
    /// Everything under CNV_Collection that the sweep can switch off, gathered once,
    /// plus the reflection handles for the bits of GambitCollectionSlide we need.
    /// All mutations are recorded so Revert() puts the screen back exactly as found.
    /// </summary>
    public sealed class CollectionTargets
    {
        public CollectionCanvas Canvas { get; private set; }
        public GameObject Root { get; private set; }
        public GambitCollectionSlide Slide { get; private set; }

        private readonly List<Behaviour> _iconBehaviours = new List<Behaviour>();
        private readonly List<Behaviour> _uifxFilters = new List<Behaviour>();
        private readonly List<Behaviour> _meshEffects = new List<Behaviour>();
        private readonly List<Behaviour> _autoLayout = new List<Behaviour>();

        // Components we switched off, so we only re-enable what we actually touched.
        private readonly List<Behaviour> _disabled = new List<Behaviour>();
        private readonly List<Component> _addedComponents = new List<Component>();

        private FieldInfo _tweenField, _gridField, _indexField;
        private GridLayoutGroup _grid;

        public bool IsBound => Canvas != null && Root != null;
        public bool IsOpen => IsBound && Root.activeInHierarchy;

        public int IconCount => _iconBehaviours.Count;
        public int UifxCount => _uifxFilters.Count;
        public int MeshEffectCount => _meshEffects.Count;
        public int AutoLayoutCount => _autoLayout.Count;

        public int PageIndex
        {
            get
            {
                if (Slide == null || _indexField == null) return -1;
                try { return (int)_indexField.GetValue(Slide); } catch { return -1; }
            }
        }

        /// <summary>Finds the (usually inactive) collection canvas in the loaded scene.</summary>
        public bool TryBind()
        {
            if (IsBound) return true;

            var all = Resources.FindObjectsOfTypeAll<CollectionCanvas>();
            for (int i = 0; i < all.Length; i++)
            {
                var c = all[i];
                // Skip anything that isn't a live scene object (asset/prefab copies).
                if (c == null || !c.gameObject.scene.IsValid()) continue;
                Canvas = c;
                Root = c.gameObject;
                break;
            }
            if (!IsBound) return false;

            Gather();
            return true;
        }

        private void Gather()
        {
            _iconBehaviours.Clear();
            _uifxFilters.Clear();
            _meshEffects.Clear();
            _autoLayout.Clear();

            foreach (var b in Root.GetComponentsInChildren<GambitLibraryIconBehaviour>(true))
                _iconBehaviours.Add(b);

            // Outline derives from Shadow, so this collects both effect types.
            foreach (var s in Root.GetComponentsInChildren<Shadow>(true))
                _meshEffects.Add(s);

            // UIFX and AutoLayoutRebuilder are matched by type name so we don't need
            // to reference ChocDino.UIFX.dll (it isn't in refs/).
            foreach (var mb in Root.GetComponentsInChildren<MonoBehaviour>(true))
            {
                if (mb == null) continue;
                var t = mb.GetType();
                if (t.Namespace == "ChocDino.UIFX") _uifxFilters.Add(mb);
                else if (t.Name == "AutoLayoutRebuilder") _autoLayout.Add(mb);
            }

            Slide = Root.GetComponentInChildren<GambitCollectionSlide>(true);
            if (Slide != null)
            {
                const BindingFlags F = BindingFlags.NonPublic | BindingFlags.Instance;
                _tweenField = typeof(GambitCollectionSlide).GetField("m_Tween", F);
                _gridField = typeof(GambitCollectionSlide).GetField("m_Grid", F);
                _indexField = typeof(GambitCollectionSlide).GetField("m_Index", F);
                try { _grid = _gridField?.GetValue(Slide) as GridLayoutGroup; } catch { }
            }
        }

        /// <summary>Reverts everything, then applies the knobs for this config.</summary>
        public void Apply(Knob knobs)
        {
            Revert();

            if ((knobs & Knob.NoIdleRotation) != 0) DisableAll(_iconBehaviours);
            if ((knobs & Knob.NoUifxFilters) != 0) DisableAll(_uifxFilters);
            if ((knobs & Knob.NoMeshEffects) != 0) DisableAll(_meshEffects);
            if ((knobs & Knob.NoAutoLayout) != 0) DisableAll(_autoLayout);
            if ((knobs & Knob.CardSubCanvas) != 0) AddCardSubCanvases();
            // GambitApi attaches this at runtime, after Gather() has already run, so
            // it has to be looked up fresh rather than from a cached list.
            if ((knobs & Knob.NoModPagination) != 0) DisableByTypeName("CollectionPaginationPatch");
        }

        private void DisableByTypeName(string typeName)
        {
            foreach (var mb in Root.GetComponentsInChildren<MonoBehaviour>(true))
            {
                if (mb == null || !mb.enabled) continue;
                if (mb.GetType().Name != typeName) continue;
                mb.enabled = false;
                _disabled.Add(mb);
            }
        }

        /// <summary>
        /// Called every frame. The spacing tween restarts itself on every page turn,
        /// so suppressing it has to be continuous rather than one-shot.
        /// </summary>
        public void Tick(Knob knobs)
        {
            if ((knobs & Knob.NoGridTween) == 0 || Slide == null || _tweenField == null) return;
            try
            {
                var tween = _tweenField.GetValue(Slide) as Tween;
                if (tween != null && tween.IsActive())
                {
                    tween.Kill();
                    _tweenField.SetValue(Slide, null);
                    if (_grid != null) _grid.spacing = new Vector2(50f, 50f); // the tween's end value
                }
            }
            catch { /* a killed tween can go null between the check and the kill */ }
        }

        private void DisableAll(List<Behaviour> list)
        {
            for (int i = 0; i < list.Count; i++)
            {
                var b = list[i];
                if (b == null || !b.enabled) continue;
                b.enabled = false;
                _disabled.Add(b);
            }
        }

        private void AddCardSubCanvases()
        {
            for (int i = 0; i < _iconBehaviours.Count; i++)
            {
                var go = _iconBehaviours[i] != null ? _iconBehaviours[i].gameObject : null;
                if (go == null || go.GetComponent<Canvas>() != null) continue;
                // Per-card guard: these cards also carry a Mask, and a nested Canvas
                // under a Mask is the most likely thing here to misbehave. One card
                // failing shouldn't cost us the whole config's measurement.
                try
                {
                    _addedComponents.Add(go.AddComponent<Canvas>());
                    // A nested Canvas registers its graphics under itself, so the parent
                    // raycaster would stop seeing the cards - hover would silently break
                    // and the numbers would be measuring the wrong thing.
                    _addedComponents.Add(go.AddComponent<GraphicRaycaster>());
                }
                catch { /* leave this card alone; Revert() still cleans up what landed */ }
            }
        }

        public void Revert()
        {
            for (int i = 0; i < _disabled.Count; i++)
                if (_disabled[i] != null) _disabled[i].enabled = true;
            _disabled.Clear();

            // Raycaster first: it depends on the Canvas being present.
            for (int i = _addedComponents.Count - 1; i >= 0; i--)
                if (_addedComponents[i] != null) UnityEngine.Object.Destroy(_addedComponents[i]);
            _addedComponents.Clear();
        }
    }
}
