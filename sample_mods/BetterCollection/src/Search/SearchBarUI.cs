using System.Collections.Generic;
using Gambonanza.GameUI;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Gambonanza.BetterCollection.Search
{
    /// <summary>
    /// The search box and its autocomplete dropdown.
    ///
    /// Built programmatically rather than cloned: the collection screen's own widgets
    /// all carry the stacked Outline chains this mod exists to remove, so cloning one
    /// would reintroduce the exact problem. Flat pixel-art colours instead.
    ///
    /// Lives on its own nested Canvas so a keystroke re-batches ~12 renderers rather
    /// than the collection's 430.
    /// </summary>
    public sealed class SearchBarUI
    {
        private const int MaxSuggestions = 6;
        private const float BarWidth = 760f;
        private const float BarHeight = 52f;
        private const float BarY = 285f;    // between the grid's top edge (251) and TXT_GambitCount (305)
        private const float RowHeight = 38f;

        private static readonly Color Cream = new Color(0.96f, 0.91f, 0.78f, 0.98f);
        private static readonly Color CreamDim = new Color(0.90f, 0.84f, 0.70f, 0.98f);
        private static readonly Color Ink = new Color(0.36f, 0.13f, 0.11f, 1f);
        private static readonly Color InkFaint = new Color(0.36f, 0.13f, 0.11f, 0.45f);
        private static readonly Color Highlight = new Color(0.85f, 0.62f, 0.36f, 1f);

        private GameObject _root;
        private TMP_Text _query;
        private TMP_Text _count;
        private TMP_Text _caret;
        private GameObject _dropdown;
        private readonly List<Image> _rowBgs = new List<Image>();
        private readonly List<TMP_Text> _rowTexts = new List<TMP_Text>();

        // Change-detection so the per-frame caret blink costs nothing else.
        private string _lastText = null;
        private bool _lastCaretVisible = true;
        private int _lastMatchCount = int.MinValue;
        private int _lastTotalCount = int.MinValue;
        private float _caretX;

        public bool Exists => _root != null;

        public void Build(Transform parent)
        {
            if (_root != null) return;

            _root = NewRect("BetterCollection_Search", parent, new Vector2(BarWidth, BarHeight),
                            new Vector2(0f, BarY));

            // Own canvas: keeps typing off the big shared batch, and overrideSorting
            // puts the dropdown above the grid without reordering the game's children.
            var canvas = _root.AddComponent<Canvas>();
            canvas.overrideSorting = true;
            canvas.sortingOrder = 10;

            var bg = _root.AddComponent<Image>();
            bg.color = Cream;
            bg.raycastTarget = false;

            _query = Pixel.CreateLabel(_root.transform, "", 26f, Ink, TextAlignmentOptions.Left);
            Stretch(_query.rectTransform, new Vector4(18f, 0f, 110f, 0f));

            _caret = Pixel.CreateLabel(_root.transform, "|", 26f, Ink, TextAlignmentOptions.Left);
            Stretch(_caret.rectTransform, new Vector4(18f, 0f, 110f, 0f));

            _count = Pixel.CreateLabel(_root.transform, "", 20f, InkFaint, TextAlignmentOptions.Right);
            Stretch(_count.rectTransform, new Vector4(0f, 0f, 16f, 0f));

            BuildDropdown();
            _root.transform.SetAsLastSibling();
        }

        private void BuildDropdown()
        {
            _dropdown = NewRect("Suggestions", _root.transform,
                                new Vector2(BarWidth, RowHeight * MaxSuggestions),
                                new Vector2(0f, -(BarHeight / 2f)));
            var rt = _dropdown.GetComponent<RectTransform>();
            rt.pivot = new Vector2(0.5f, 1f);   // grows downward from under the bar

            var bg = _dropdown.AddComponent<Image>();
            bg.color = CreamDim;
            bg.raycastTarget = false;

            for (int i = 0; i < MaxSuggestions; i++)
            {
                var row = NewRect("Row" + i, _dropdown.transform, new Vector2(BarWidth, RowHeight),
                                  new Vector2(0f, -RowHeight * i));
                var rrt = row.GetComponent<RectTransform>();
                rrt.anchorMin = new Vector2(0.5f, 1f);
                rrt.anchorMax = new Vector2(0.5f, 1f);
                rrt.pivot = new Vector2(0.5f, 1f);

                var rowBg = row.AddComponent<Image>();
                rowBg.color = new Color(0f, 0f, 0f, 0f);
                rowBg.raycastTarget = false;
                _rowBgs.Add(rowBg);

                var t = Pixel.CreateLabel(row.transform, "", 22f, Ink, TextAlignmentOptions.Left);
                Stretch(t.rectTransform, new Vector4(24f, 0f, 24f, 0f));
                _rowTexts.Add(t);
            }
            _dropdown.SetActive(false);
        }

        /// <param name="matchCount">-1 hides the counter (nothing typed yet).</param>
        public void SetQuery(string text, int matchCount, int totalCount, bool caretVisible)
        {
            if (_root == null) return;

            // Called every frame for the caret blink, so everything here early-outs on
            // no-change. Re-assigning TMP.text or re-measuring with GetPreferredValues
            // each frame would dirty this canvas every frame - the exact per-frame
            // rebuild cost the rest of this mod exists to remove.
            if (text != _lastText)
            {
                _lastText = text;
                bool empty = string.IsNullOrEmpty(text);
                _query.text = empty ? "type to search gambits..." : text;
                _query.color = empty ? InkFaint : Ink;

                // Park the caret just after the text. TMP's preferred width is exact,
                // so this tracks the proportional pixel font correctly.
                _caretX = empty ? 0f : _query.GetPreferredValues(text).x;
                _caret.rectTransform.anchoredPosition = new Vector2(_caretX, 0f);
            }

            if (caretVisible != _lastCaretVisible)
            {
                _lastCaretVisible = caretVisible;
                _caret.gameObject.SetActive(caretVisible);
            }

            if (matchCount != _lastMatchCount || totalCount != _lastTotalCount)
            {
                _lastMatchCount = matchCount;
                _lastTotalCount = totalCount;
                _count.text = matchCount < 0 ? "" : $"{matchCount}/{totalCount}";
                _count.color = matchCount == 0 ? new Color(0.65f, 0.20f, 0.15f, 1f) : InkFaint;
            }
        }

        public void SetSuggestions(IReadOnlyList<string> names, int selected)
        {
            if (_root == null) return;

            int n = Mathf.Min(names?.Count ?? 0, MaxSuggestions);
            _dropdown.SetActive(n > 0);
            if (n == 0) return;

            var rt = _dropdown.GetComponent<RectTransform>();
            rt.sizeDelta = new Vector2(BarWidth, RowHeight * n);

            for (int i = 0; i < MaxSuggestions; i++)
            {
                bool used = i < n;
                _rowTexts[i].transform.parent.gameObject.SetActive(used);
                if (!used) continue;
                _rowTexts[i].text = names[i];
                _rowBgs[i].color = (i == selected) ? Highlight : new Color(0f, 0f, 0f, 0f);
            }
        }

        public void HideSuggestions()
        {
            if (_dropdown != null) _dropdown.SetActive(false);
        }

        public void SetVisible(bool visible)
        {
            if (_root != null) _root.SetActive(visible);
        }

        public void Destroy()
        {
            if (_root != null) Object.Destroy(_root);
            _root = null;
            _rowBgs.Clear();
            _rowTexts.Clear();
            _lastText = null;
            _lastMatchCount = _lastTotalCount = int.MinValue;
        }

        private static GameObject NewRect(string name, Transform parent, Vector2 size, Vector2 pos)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = go.GetComponent<RectTransform>();
            rt.anchorMin = rt.anchorMax = new Vector2(0.5f, 0.5f);
            rt.pivot = new Vector2(0.5f, 0.5f);
            rt.sizeDelta = size;
            rt.anchoredPosition = pos;
            return go;
        }

        /// <summary>Stretch to the parent with (left, top, right, bottom) padding.</summary>
        private static void Stretch(RectTransform rt, Vector4 padding)
        {
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.offsetMin = new Vector2(padding.x, padding.w);
            rt.offsetMax = new Vector2(-padding.z, -padding.y);
        }
    }
}
