using System.Collections.Generic;
using System.Reflection;
using Blukulele.CHE;
using UnityEngine;

namespace Gambonanza.GambitApi
{
    /// <summary>
    /// Automatically attached to GambitCollectionSlide at runtime. Two responsibilities:
    ///
    ///  1. Pad <c>m_Hints</c> with clones so the page indicator has a dot for each page
    ///     implied by <c>ceil(count/10)</c>.
    ///  2. Monitor <c>m_Index</c> after vanilla IncreaseIndex/DecreaseIndex runs and undo
    ///     the early wrap caused by integer division. Works regardless of how the UI arrows
    ///     are wired (so we never need to fight inspector-bound onClick listeners).
    /// </summary>
    public class CollectionPaginationPatch : MonoBehaviour
    {
        private GambitCollectionSlide _slide;
        private FieldInfo _indexField;
        private FieldInfo _ordererField;
        private FieldInfo _hintsField;
        private FieldInfo _iconsField;
        private FieldInfo _mouseOverField;
        private MethodInfo _updateMethod;
        private int _lastIndex;
        private int _lastEnforcedCount = -1;
        private int _lastEnforcedIndex = -1;
        private readonly List<HintCircleBehaviour> _addedHints = new List<HintCircleBehaviour>();

        private void Awake()
        {
            _slide = GetComponent<GambitCollectionSlide>();
            if (_slide == null)
            {
                Debug.LogError("[GambitApi] CollectionPaginationPatch requires a GambitCollectionSlide on the same GameObject.");
                Destroy(this);
                return;
            }

            _indexField = typeof(GambitCollectionSlide).GetField("m_Index", BindingFlags.NonPublic | BindingFlags.Instance);
            _ordererField = typeof(GambitCollectionSlide).GetField("m_GambitOrderer", BindingFlags.NonPublic | BindingFlags.Instance);
            _hintsField = typeof(GambitCollectionSlide).GetField("m_Hints", BindingFlags.NonPublic | BindingFlags.Instance);
            _iconsField = typeof(GambitCollectionSlide).GetField("m_GambitIconBehaviour", BindingFlags.NonPublic | BindingFlags.Instance);
            _mouseOverField = typeof(GambitLibraryIconBehaviour).GetField("m_MouseOver", BindingFlags.NonPublic | BindingFlags.Instance);
            _updateMethod = typeof(GambitCollectionSlide).GetMethod("UpdateUI", BindingFlags.NonPublic | BindingFlags.Instance);
        }

        private void OnEnable()
        {
            if (_slide == null) return;

            var initField = typeof(GambitCollectionSlide).GetField("m_Initialize", BindingFlags.NonPublic | BindingFlags.Instance);
            initField?.SetValue(_slide, false);

            _lastIndex = 0;
            // Re-enforce on reopen: vanilla resets slot state while the
            // collection is closed.
            _lastEnforcedCount = -1;
            _lastEnforcedIndex = -1;

            // Wait one frame so the slide's OnEnable -> UpdateGambit can rebuild the orderer,
            // then extend the hint dots and re-run UpdateUI to highlight the right one.
            StartCoroutine(EnsureHintsAfterFrame());
        }

        private void OnDisable() => RemoveAddedHints();

        // LateUpdate runs after Unity UI events have processed for the frame, so by the time
        // we read m_Index here, vanilla IncreaseIndex/DecreaseIndex from a click has already run.
        private void LateUpdate()
        {
            if (_slide == null) return;
            var orderer = _ordererField?.GetValue(_slide) as List<SO_Gambit>;
            if (orderer == null || orderer.Count == 0) return;

            int count = orderer.Count;
            int current = (int)(_indexField?.GetValue(_slide) ?? 0);
            int vanillaPageCount = count / 10;            // what vanilla thinks the page count is
            int realPageCount = Mathf.CeilToInt(count / 10f); // what it should be when count isn't a multiple of 10
            if (realPageCount == vanillaPageCount)
            {
                // No partial page right now, but slots may still be hidden from an
                // earlier partial-page state (count can change via mods rescan).
                MaybeEnforceSlotVisibility(count, current);
                _lastIndex = current;
                return;
            }

            int prev = _lastIndex;

            // Forward wrap: vanilla goes from page (vanillaPageCount-1) → wraps to 0,
            // skipping the modded extra page. Re-route to the extra page.
            if (current == 0 && prev == vanillaPageCount - 1 && vanillaPageCount > 0)
            {
                current = vanillaPageCount; // = realPageCount - 1, the modded page
                _indexField.SetValue(_slide, current);
                EnsureHintsCount(count);
                _updateMethod?.Invoke(_slide, null);
            }
            // Backward wrap: vanilla wraps 0 → (vanillaPageCount-1), again missing the extra page.
            else if (prev == 0 && current == vanillaPageCount - 1 && vanillaPageCount > 0)
            {
                current = realPageCount - 1;
                _indexField.SetValue(_slide, current);
                EnsureHintsCount(count);
                _updateMethod?.Invoke(_slide, null);
            }

            _lastIndex = current;

            MaybeEnforceSlotVisibility(count, current);
        }

        // Enforce only when the page or the library count actually changed.
        // Doing it every frame risked a SetActive tug-of-war with vanilla's
        // own slot updates - each toggle dirties the whole canvas layout, and
        // per-frame canvas rebuilds are exactly the kind of thing that turns
        // the collection screen into a slideshow.
        private void MaybeEnforceSlotVisibility(int gambitCount, int pageIndex)
        {
            if (gambitCount == _lastEnforcedCount && pageIndex == _lastEnforcedIndex) return;
            _lastEnforcedCount = gambitCount;
            _lastEnforcedIndex = pageIndex;
            EnforceSlotVisibility(gambitCount, pageIndex);
        }

        // Vanilla DoNotShow() only disables the slot's three Image components; the
        // GameObject stays active, so the m_Lock chains child (left over from whatever
        // locked gambit the slot rendered on a previous page), the hover EventTrigger,
        // the medal, and the exclamation point all keep working on "empty" slots.
        // Vanilla never notices because 200 gambits fill every page exactly; any modded
        // count that isn't a multiple of 10 creates the first partial page in the game.
        // Deactivating the whole slot GameObject removes the leftovers AND lets the
        // GridLayoutGroup pack the real cards cleanly. Reactivation is enforced every
        // frame so vanilla's UpdateGambit/Initialize keeps working when the slot comes
        // back into range on another page.
        private void EnforceSlotVisibility(int gambitCount, int pageIndex)
        {
            var icons = _iconsField?.GetValue(_slide) as List<GambitLibraryIconBehaviour>;
            if (icons == null) return;

            for (int i = 0; i < icons.Count; i++)
            {
                var icon = icons[i];
                if (icon == null) continue;
                bool inRange = pageIndex * 10 + i < gambitCount;
                var go = icon.gameObject;
                if (go.activeSelf == inRange) continue;

                if (!inRange)
                {
                    // If the pointer is currently on this slot, close the tooltip and
                    // reset the hover state before deactivating, otherwise the shared
                    // GambitInfoCollection popup stays open with stale info.
                    if (_mouseOverField != null && (bool)_mouseOverField.GetValue(icon))
                    {
                        try { icon.Hide(); }
                        catch { /* tooltip already gone - nothing to clean up */ }
                    }
                }
                go.SetActive(inRange);
            }
        }

        private System.Collections.IEnumerator EnsureHintsAfterFrame()
        {
            yield return null;
            var orderer = _ordererField?.GetValue(_slide) as List<SO_Gambit>;
            if (orderer == null || orderer.Count == 0) yield break;
            if (EnsureHintsCount(orderer.Count))
                _updateMethod?.Invoke(_slide, null);
            _lastIndex = (int)(_indexField?.GetValue(_slide) ?? 0);
        }

        // Pads m_Hints with clones of an existing hint so the game's UpdateHints()
        // has a dot for every page implied by ceil(count/10). Returns true when
        // it actually added clones this call. Clones are tracked and removed in OnDisable
        // so vanilla state is restored if the mod is removed and the scene reloads.
        private bool EnsureHintsCount(int gambitCount)
        {
            var hints = _hintsField?.GetValue(_slide) as List<HintCircleBehaviour>;
            if (hints == null) return false;

            int requiredPages = Mathf.CeilToInt(gambitCount / 10f);
            if (hints.Count >= requiredPages) return false;

            HintCircleBehaviour template = null;
            for (int i = hints.Count - 1; i >= 0; i--)
            {
                if (hints[i] != null) { template = hints[i]; break; }
            }
            if (template == null || template.transform.parent == null)
            {
                Debug.LogWarning("[GambitApi] No HintCircleBehaviour template available; cannot extend page indicators.");
                return false;
            }

            Transform parent = template.transform.parent;
            int added = 0;
            while (hints.Count < requiredPages)
            {
                var clone = UnityEngine.Object.Instantiate(template, parent);
                clone.name = template.name + "_modclone_" + hints.Count;
                clone.gameObject.SetActive(true);
                hints.Add(clone);
                _addedHints.Add(clone);
                added++;
            }
            Debug.Log($"[GambitApi] Extended page indicators by {added} (total now {hints.Count} for {gambitCount} gambits).");
            return true;
        }

        private void RemoveAddedHints()
        {
            if (_addedHints.Count == 0) return;
            var hints = _hintsField?.GetValue(_slide) as List<HintCircleBehaviour>;
            foreach (var h in _addedHints)
            {
                if (h == null) continue;
                hints?.Remove(h);
                UnityEngine.Object.Destroy(h.gameObject);
            }
            _addedHints.Clear();
        }
    }
}
