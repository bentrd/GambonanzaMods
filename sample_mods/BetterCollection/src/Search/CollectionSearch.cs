using System;
using System.Collections.Generic;
using System.Reflection;
using Blukulele.CHE;
using UnityEngine;

namespace Gambonanza.BetterCollection.Search
{
    /// <summary>
    /// Live gambit filtering for the collection screen.
    ///
    /// Filtering works by swapping the contents of the slide's private
    /// <c>m_GambitOrderer</c> and re-rendering. Vanilla only rebuilds that list when
    /// its <c>m_Initialize</c> flag is false, so once the screen is open the game is
    /// happy to page through whatever we put in there.
    /// </summary>
    public sealed class CollectionSearch : MonoBehaviour
    {
        private const int PageSize = 10;
        private const float ApplyDebounce = 0.12f;
        private const int MaxSuggestions = 6;

        private static readonly BindingFlags F = BindingFlags.NonPublic | BindingFlags.Instance;

        private GambitCollectionSlide _slide;
        private FieldInfo _ordererField, _indexField, _iconsField, _hintsField;
        private MethodInfo _updateGambit, _updateHints;

        private readonly GambitIndex _index = new GambitIndex();
        private readonly SearchBarUI _ui = new SearchBarUI();
        private readonly List<SO_Gambit> _master = new List<SO_Gambit>();
        private readonly List<GambitIndex.Entry> _results = new List<GambitIndex.Entry>();
        private readonly List<string> _suggestionNames = new List<string>();

        private Func<bool> _isConsoleOpen;
        private Action<string> _log;

        private string _query = "";
        private int _selected;
        private int _framesOpen;
        private bool _captured;
        private bool _filterActive;
        private float _applyAt = -1f;
        private int _lastEnforcedIndex = -1;
        private int _lastEnforcedCount = -1;

        public void Bind(GambitCollectionSlide slide, Func<bool> isConsoleOpen, Action<string> log)
        {
            _slide = slide;
            _isConsoleOpen = isConsoleOpen;
            _log = log;

            var t = typeof(GambitCollectionSlide);
            _ordererField = t.GetField("m_GambitOrderer", F);
            _indexField = t.GetField("m_Index", F);
            _iconsField = t.GetField("m_GambitIconBehaviour", F);
            _hintsField = t.GetField("m_Hints", F);
            // Deliberately not UpdateUI: it calls UpdateVisual, which restarts the
            // 0.45s grid-spacing tween - on every keystroke that is both ugly and
            // exactly the layout thrash this mod exists to avoid.
            _updateGambit = t.GetMethod("UpdateGambit", F);
            _updateHints = t.GetMethod("UpdateHints", F);

            if (_ordererField == null || _indexField == null || _updateGambit == null)
                _log?.Invoke("search: GambitCollectionSlide layout changed; search disabled.");
        }

        private bool Usable => _slide != null && _ordererField != null && _indexField != null && _updateGambit != null;

        private List<SO_Gambit> Orderer => _ordererField?.GetValue(_slide) as List<SO_Gambit>;

        // This component sits ON the slide GameObject, which is deactivated with the
        // screen - so Update() simply stops running when the collection closes. The
        // open/close edges therefore have to come from Unity's own messages; polling
        // activeInHierarchy in Update() could never observe the closed state.
        private void OnEnable()
        {
            if (Usable) OnOpened();
        }

        private void OnDisable()
        {
            if (Usable) OnClosed();
        }

        private void Update()
        {
            if (!Usable) return;

            _framesOpen++;
            if (!_captured) { TryCapture(); return; }

            HandleInput();

            if (_applyAt >= 0f && Time.unscaledTime >= _applyAt)
            {
                _applyAt = -1f;
                ApplyFilter();
            }

            _ui.SetQuery(_query, _query.Length == 0 ? -1 : _results.Count, _master.Count,
                         Mathf.Repeat(Time.unscaledTime, 1f) < 0.5f);

            if (_filterActive) EnforceVisibility();
        }

        private void OnOpened()
        {
            _framesOpen = 0;
            _captured = false;
            _query = "";
            _selected = 0;
            _filterActive = false;
            _lastEnforcedCount = _lastEnforcedIndex = -1;
        }

        private void OnClosed()
        {
            if (_captured && _filterActive) RestoreAll();
            _captured = false;
            _ui.HideSuggestions();
        }

        /// <summary>
        /// Snapshot the full list once vanilla (and GambitApi, which forces a rebuild
        /// in its own OnEnable) have finished populating it.
        /// </summary>
        private void TryCapture()
        {
            if (_framesOpen < 3) return;
            var orderer = Orderer;
            if (orderer == null || orderer.Count == 0) return;

            _master.Clear();
            _master.AddRange(orderer);
            _index.Build(_master);
            _captured = true;

            _ui.Build(_slide.transform);
            _ui.SetVisible(true);
            _ui.SetQuery("", -1, _master.Count, true);
            _ui.HideSuggestions();
        }

        private void HandleInput()
        {
            if (_isConsoleOpen != null && _isConsoleOpen()) return;

            bool changed = false;

            foreach (char c in Input.inputString)
            {
                if (c == '\b')
                {
                    if (_query.Length > 0) { _query = _query.Substring(0, _query.Length - 1); changed = true; }
                }
                else if (c == '\n' || c == '\r')
                {
                    AcceptSuggestion();
                    return;
                }
                else if (c == '`' || c == '\t' || char.IsControl(c))
                {
                    // backtick toggles the mod console, tab is handled as a key below
                }
                else if (_query.Length < 40)
                {
                    _query += c;
                    changed = true;
                }
            }

            if (Input.GetKeyDown(KeyCode.Tab)) { AcceptSuggestion(); return; }

            if (_suggestionNames.Count > 0)
            {
                if (Input.GetKeyDown(KeyCode.DownArrow))
                {
                    _selected = (_selected + 1) % _suggestionNames.Count;
                    _ui.SetSuggestions(_suggestionNames, _selected);
                }
                else if (Input.GetKeyDown(KeyCode.UpArrow))
                {
                    _selected = (_selected - 1 + _suggestionNames.Count) % _suggestionNames.Count;
                    _ui.SetSuggestions(_suggestionNames, _selected);
                }
            }

            if (changed) OnQueryChanged();
        }

        private void OnQueryChanged()
        {
            _selected = 0;

            _results.Clear();
            _results.AddRange(_index.Search(_query));

            // Suggestions and the counter update instantly (they are just text); only
            // the grid rebuild is debounced, since that one re-renders 10 cards.
            _suggestionNames.Clear();
            if (_query.Length > 0)
            {
                int n = Mathf.Min(_results.Count, MaxSuggestions);
                for (int i = 0; i < n; i++) _suggestionNames.Add(_results[i].DisplayName);
            }
            _ui.SetSuggestions(_suggestionNames, _selected);

            _applyAt = Time.unscaledTime + ApplyDebounce;
        }

        private void AcceptSuggestion()
        {
            if (_suggestionNames.Count == 0) return;
            int i = Mathf.Clamp(_selected, 0, _suggestionNames.Count - 1);
            _query = _suggestionNames[i];
            _selected = 0;

            _results.Clear();
            _results.AddRange(_index.Search(_query));
            _suggestionNames.Clear();
            _ui.HideSuggestions();
            ApplyFilter();
            _applyAt = -1f;
        }

        private void ApplyFilter()
        {
            var orderer = Orderer;
            if (orderer == null) return;

            orderer.Clear();
            if (_query.Length == 0)
            {
                orderer.AddRange(_master);
                _filterActive = false;
            }
            else
            {
                for (int i = 0; i < _results.Count; i++) orderer.Add(_results[i].Gambit);
                _filterActive = true;
            }

            _indexField.SetValue(_slide, 0);
            try
            {
                _updateGambit.Invoke(_slide, null);
                _updateHints?.Invoke(_slide, null);
            }
            catch (Exception ex)
            {
                _log?.Invoke("search refresh failed: " + ex.Message);
            }

            _lastEnforcedCount = _lastEnforcedIndex = -1;
            EnforceVisibility();
        }

        private void RestoreAll()
        {
            var orderer = Orderer;
            if (orderer != null)
            {
                orderer.Clear();
                orderer.AddRange(_master);
            }
            _indexField.SetValue(_slide, 0);
            try
            {
                _updateGambit.Invoke(_slide, null);
                _updateHints?.Invoke(_slide, null);
            }
            catch { }

            SetIconsActive(int.MaxValue, 0);
            SetHintsActive(int.MaxValue);
            _filterActive = false;
        }

        /// <summary>
        /// Vanilla's DoNotShow only disables a slot's three Images - the GameObject
        /// stays live, so its lock icon, hover trigger and medal keep working on an
        /// "empty" slot. With 200 gambits every page is exactly full so vanilla never
        /// notices; a filtered result almost never is.
        /// </summary>
        private void EnforceVisibility()
        {
            int count = Orderer?.Count ?? 0;
            int page = (int)_indexField.GetValue(_slide);
            if (count == _lastEnforcedCount && page == _lastEnforcedIndex) return;
            _lastEnforcedCount = count;
            _lastEnforcedIndex = page;

            SetIconsActive(count, page);
            SetHintsActive(Mathf.Max(1, Mathf.CeilToInt(count / (float)PageSize)));
        }

        private void SetIconsActive(int count, int page)
        {
            var icons = _iconsField?.GetValue(_slide) as List<GambitLibraryIconBehaviour>;
            if (icons == null) return;
            for (int i = 0; i < icons.Count; i++)
            {
                if (icons[i] == null) continue;
                bool want = page * PageSize + i < count;
                var go = icons[i].gameObject;
                if (go.activeSelf != want) go.SetActive(want);
            }
        }

        private void SetHintsActive(int pages)
        {
            var hints = _hintsField?.GetValue(_slide) as List<HintCircleBehaviour>;
            if (hints == null) return;
            for (int i = 0; i < hints.Count; i++)
            {
                if (hints[i] == null) continue;
                bool want = i < pages;
                var go = hints[i].gameObject;
                if (go.activeSelf != want) go.SetActive(want);
            }
        }

        public void TearDown()
        {
            if (Usable && _captured && _filterActive)
            {
                try { RestoreAll(); } catch { }
            }
            _ui.Destroy();
        }
    }
}
