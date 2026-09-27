using System;
using System.Collections.Generic;
using System.Reflection;
using Blukulele.Audio;
using Blukulele.CHE;
using Blukulele.Core;
using Blukulele.Module.Audio;
using DG.Tweening;
using TMPro;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace Gambonanza.StrainApi
{
    /// <summary>
    /// Puts modded strains on the game's own Custom strain screen (CanvasStrainModifier).
    ///
    /// The screen is built for the game's 15 strains: a fixed 5x3 grid under a 30-point
    /// heat gauge. So modded strains get pages of their own. ◀ ▶ arrows either side of
    /// the STRAINS title switch between the game's page and pages of up to 15 modded
    /// strains, laid out by a copy of the game's grid. Each modded card is a clone of one
    /// of the game's strain buttons (same card, icon, heat chip, check mark and tooltip)
    /// with its StrainButton swapped for <see cref="ModStrainCard"/>, which toggles the
    /// player's pick instead of a vanilla strain.
    ///
    /// Heat goes through the screen's own IncreaseStrainScore/DecreaseStrainScore, so
    /// the gauge, its markers and the run's recorded heat all count modded strains - and
    /// may go past 30. The screen recounts the game's strains from zero every time it
    /// opens; the modded heat is added back on top a frame later (LateUpdate), and kept
    /// in step with every change of the picks after that.
    /// </summary>
    internal sealed class StrainScreen : MonoBehaviour
    {
        private const int PageSize = 15;
        private const string ModdedTitle = "Mod Strains";
        private const string ModdedExplanation = "Strains added by mods. Their heat counts like any other!";

        private static StrainScreen _instance;

        private static readonly BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Instance;
        private static readonly FieldInfo GridField = typeof(CanvasStrainModifier).GetField("m_Grid", Private);
        private static readonly FieldInfo HeaderField = typeof(CanvasStrainModifier).GetField("m_Header", Private);
        private static readonly FieldInfo MixAndMatchField = typeof(CanvasStrainModifier).GetField("m_MixAndMatch", Private);
        private static readonly FieldInfo SelectAllField = typeof(CanvasStrainModifier).GetField("m_BTN_SelectAll", Private);
        private static readonly FieldInfo DeselectAllField = typeof(CanvasStrainModifier).GetField("m_BTN_UnselectAll", Private);

        private CanvasStrainModifier _canvas;
        private Transform _grid;                 // the game's grid of 15 StrainButtons
        private TMP_Text _header;
        private TMP_Text _explanation;
        private bool _bound;
        private bool _bindFailed;

        private RectTransform _modGrid;          // our copy of the grid, for the modded pages
        private readonly List<ModStrainCard> _cards = new List<ModStrainCard>();
        private readonly List<GameObject> _spacers = new List<GameObject>();
        private GameObject _prev;
        private GameObject _next;
        private int _builtVersion = -1;

        private int _page;                       // 0: the game's strains; 1..n: modded ones
        private string _vanillaHeader;
        private string _vanillaExplanation;

        private int _appliedHeat;                // modded heat currently added to the gauge
        private bool _heatDirty;

        private readonly List<KeyValuePair<UnityEvent<BaseEventData>, UnityAction<BaseEventData>>> _hooks =
            new List<KeyValuePair<UnityEvent<BaseEventData>, UnityAction<BaseEventData>>>();

        private int PageCount => 1 + (_cards.Count + PageSize - 1) / PageSize;

        // ----- attaching ------------------------------------------------------

        /// <summary>
        /// Called by StrainCore's ticker: attach to the game's strain screen once it
        /// exists. The component waits on the (usually inactive) canvas until it opens.
        /// </summary>
        internal static void EnsureAttached()
        {
            if (_instance) return;
            var canvas = UnityEngine.Object.FindAnyObjectByType<CanvasStrainModifier>(FindObjectsInactive.Include);
            if (!canvas) return;
            _instance = canvas.GetComponent<StrainScreen>();
            if (!_instance) _instance = canvas.gameObject.AddComponent<StrainScreen>();
        }

        /// <summary>StrainApi disabled: put the screen back the way the game built it.</summary>
        internal static void Detach()
        {
            if (_instance) Destroy(_instance);
            _instance = null;
        }

        private bool Bind()
        {
            if (_bound) return true;
            if (_bindFailed) return false;
            try
            {
                _canvas = GetComponent<CanvasStrainModifier>();
                _grid = GridField?.GetValue(_canvas) as Transform;
                _header = HeaderField?.GetValue(_canvas) as TMP_Text;
                _explanation = MixAndMatchField?.GetValue(_canvas) as TMP_Text;
                if (!_canvas || !_grid || !_header) throw new MissingMemberException("CanvasStrainModifier.m_Grid/m_Header");
                HookBulkButton(SelectAllField?.GetValue(_canvas) as Transform, "SelectAll", SelectAllModded);
                HookBulkButton(DeselectAllField?.GetValue(_canvas) as Transform, "DeselectAll", () => StrainCore.ClearSelection());
                _bound = true;
            }
            catch (Exception ex)
            {
                _bindFailed = true;
                StrainCore.Log("could not attach to the Custom strain screen, so modded strains cannot be picked there " +
                               "('strain on <id>' in the console still works): " + ex.Message);
            }
            return _bound;
        }

        // ----- Unity lifecycle --------------------------------------------------

        private void OnEnable()
        {
            if (!Bind()) return;
            StrainCore.SelectionChanged += OnSelectionChanged;
            // The screen recounts its heat from zero every time it opens (its own OnEnable),
            // with nothing of ours in it.
            _appliedHeat = 0;
            _heatDirty = true;
            _page = 0;
            _vanillaHeader = _vanillaExplanation = null;
            if (_modGrid) ShowPage(0);
            foreach (var card in _cards) if (card) card.Refresh(animate: false);
        }

        private void OnDisable()
        {
            StrainCore.SelectionChanged -= OnSelectionChanged;
            // Closed on a modded page: put the game's page back now, while its title and
            // explanation are still remembered. OnEnable forgets them, so waiting until
            // the screen reopens would leave "Mod Strains" over the game's grid.
            if (!_bound || _page == 0) return;
            try { ShowPage(0); }
            catch (Exception ex) { StrainCore.Log("could not put the game's strain page back on close: " + ex.Message); }
        }

        private void LateUpdate()
        {
            if (!_bound) return;
            try
            {
                if (_builtVersion != StrainRegistry.Version) Rebuild();
                if (_heatDirty) SyncHeat();
            }
            catch (Exception ex)
            {
                _builtVersion = StrainRegistry.Version;   // do not retry every frame
                _heatDirty = false;
                StrainCore.Log("the modded strain page failed: " + ex);
            }
        }

        private void OnDestroy()
        {
            StrainCore.SelectionChanged -= OnSelectionChanged;
            foreach (var hook in _hooks) hook.Key.RemoveListener(hook.Value);
            _hooks.Clear();
            if (!_bound) return;
            try
            {
                // Only while the screen is open: closed, it recounts from zero when it reopens.
                if (_appliedHeat > 0 && _canvas && _canvas.isActiveAndEnabled) _canvas.DecreaseStrainScore(_appliedHeat);
                _appliedHeat = 0;
                if (_page != 0) ShowPage(0);
                if (_grid) _grid.gameObject.SetActive(true);
                if (_modGrid) Destroy(_modGrid.gameObject);
                if (_prev) Destroy(_prev);
                if (_next) Destroy(_next);
            }
            catch (Exception ex) { StrainCore.Log("could not put the Custom strain screen back cleanly: " + ex.Message); }
        }

        private void OnSelectionChanged()
        {
            foreach (var card in _cards) if (card) card.Refresh(animate: true);
            _heatDirty = true;
        }

        // ----- heat -----------------------------------------------------------

        private void SyncHeat()
        {
            _heatDirty = false;
            int wanted = 0;
            foreach (var def in StrainRegistry.All)
                if (StrainCore.IsSelected(def.Id)) wanted += def.Heat;
            int delta = wanted - _appliedHeat;
            if (delta > 0) _canvas.IncreaseStrainScore(delta);
            else if (delta < 0) _canvas.DecreaseStrainScore(-delta);
            _appliedHeat = wanted;
        }

        private static void SelectAllModded()
        {
            foreach (var def in StrainRegistry.All)
                if (!StrainCore.IsSelected(def.Id)) StrainCore.SetSelected(def, true);
        }

        // ----- building -------------------------------------------------------

        private void Rebuild()
        {
            _builtVersion = StrainRegistry.Version;
            foreach (var card in _cards)
            {
                if (!card) continue;
                // Inactive first: Destroy lands at the end of the frame, and the grid
                // would lay the old cards out next to the new ones until then.
                card.gameObject.SetActive(false);
                Destroy(card.gameObject);
            }
            _cards.Clear();

            var all = StrainRegistry.All;
            if (all.Count > 0)
            {
                if (!_modGrid) BuildGrid();
                if (!_prev) _prev = BuildArrow("StrainApi_PrevPage", "<", -1);
                if (!_next) _next = BuildArrow("StrainApi_NextPage", ">", +1);
                var template = TemplateButton();
                foreach (var def in all)
                {
                    var card = ModStrainCard.Create(template, _modGrid, def);
                    if (card) _cards.Add(card);
                }
                foreach (var spacer in _spacers) spacer.transform.SetAsLastSibling();
            }

            bool any = _cards.Count > 0;
            if (_prev) _prev.SetActive(any);
            if (_next) _next.SetActive(any);
            ShowPage(Mathf.Clamp(_page, 0, PageCount - 1));
            _heatDirty = true;
        }

        private StrainButton TemplateButton()
        {
            foreach (Transform child in _grid)
            {
                var button = child.GetComponent<StrainButton>();
                if (button) return button;
            }
            throw new MissingMemberException("no StrainButton in the strain grid to copy");
        }

        /// <summary>
        /// A copy of the game's grid - same rect, same GridLayoutGroup - filled from the top
        /// left. Each page always holds 15 children (cards, then spacers), so the block is
        /// laid out exactly where the game's own 5x3 sits, over its column backgrounds.
        /// </summary>
        private void BuildGrid()
        {
            var source = (RectTransform)_grid;
            var go = new GameObject("StrainApi_ModStrains", typeof(RectTransform));
            _modGrid = (RectTransform)go.transform;
            _modGrid.SetParent(source.parent, false);
            _modGrid.SetSiblingIndex(source.GetSiblingIndex() + 1);
            _modGrid.anchorMin = source.anchorMin;
            _modGrid.anchorMax = source.anchorMax;
            _modGrid.pivot = source.pivot;
            _modGrid.anchoredPosition = source.anchoredPosition;
            _modGrid.sizeDelta = source.sizeDelta;
            _modGrid.localScale = source.localScale;
            _modGrid.localRotation = source.localRotation;

            var vanilla = source.GetComponent<GridLayoutGroup>();
            var layout = go.AddComponent<GridLayoutGroup>();
            if (vanilla)
            {
                layout.padding = new RectOffset(vanilla.padding.left, vanilla.padding.right, vanilla.padding.top, vanilla.padding.bottom);
                layout.cellSize = vanilla.cellSize;
                layout.spacing = vanilla.spacing;
                layout.startAxis = vanilla.startAxis;
                layout.childAlignment = vanilla.childAlignment;
                layout.constraint = vanilla.constraint;
                layout.constraintCount = vanilla.constraintCount;
            }
            // The game fills its grid from the bottom right (cheapest strains first); a
            // modded page reads like a page: from the top left.
            layout.startCorner = GridLayoutGroup.Corner.UpperLeft;
            layout.startAxis = GridLayoutGroup.Axis.Horizontal;

            for (int i = 0; i < PageSize; i++)
            {
                var spacer = new GameObject("Empty", typeof(RectTransform));
                spacer.transform.SetParent(_modGrid, false);
                _spacers.Add(spacer);
            }
            go.SetActive(false);
        }

        /// <summary>
        /// A page arrow: a clone of the screen's own close button (the square one at the
        /// panel's corner), set either side of the title, with its close action muted.
        /// </summary>
        private GameObject BuildArrow(string name, string label, int direction)
        {
            var title = _header.transform.parent as RectTransform;       // PromotionHeader
            var panel = title != null ? title.parent : null;              // ResultsContainer
            var close = panel != null ? panel.Find("BTN_Close") as RectTransform : null;
            if (title == null || close == null) throw new MissingMemberException("the strain screen's title or close button");

            var arrow = CardSurgery.CloneInactive(close.gameObject, panel, name);
            var rt = (RectTransform)arrow.transform;
            PlaceBeside(rt, title, panel, direction);

            var text = arrow.GetComponentInChildren<TMP_Text>(true);
            if (text)
            {
                text.richText = false;
                text.text = label;
            }

            // The clone still carries the close button's wiring: mute whatever points
            // outside it (CanvasStrainModifier.Close), and turn the page from that entry.
            bool hooked = false;
            foreach (var trigger in arrow.GetComponentsInChildren<EventTrigger>(true))
            {
                if (trigger.triggers == null) continue;
                foreach (var entry in trigger.triggers)
                {
                    if (!CardSurgery.MuteExternal(entry, arrow.transform)) continue;
                    entry.callback.AddListener(_ => Turn(direction));
                    hooked = true;
                }
            }
            if (!hooked)
            {
                var trigger = arrow.GetComponentInChildren<EventTrigger>(true) ?? arrow.AddComponent<EventTrigger>();
                var entry = new EventTrigger.Entry { eventID = EventTriggerType.PointerClick };
                entry.callback.AddListener(_ => Turn(direction));
                trigger.triggers.Add(entry);
            }
            arrow.SetActive(true);
            return arrow;
        }

        /// <summary>
        /// Centre the arrow's visible button on the title's middle line, a fixed gap from
        /// its side. The close button it is cloned from is pivoted on its corner and its
        /// visible part sits above its own rect, so this measures the drawn button (its
        /// largest Image) rather than trusting the root rect.
        /// </summary>
        private static void PlaceBeside(RectTransform arrow, RectTransform title, Transform panel, int direction)
        {
            const float Gap = 24f;
            arrow.anchorMin = arrow.anchorMax = title.anchorMin;
            arrow.pivot = new Vector2(0.5f, 0.5f);
            var titleCenter = title.anchoredPosition + Vector2.Scale(new Vector2(0.5f, 0.5f) - title.pivot, title.rect.size);
            float offset = title.rect.width * 0.5f + arrow.rect.width * 0.5f + Gap;
            arrow.anchoredPosition = titleCenter + new Vector2(direction * offset, 0f);

            var visual = LargestImage(arrow);
            if (visual == null || visual.rectTransform == arrow) return;
            var drift = panel.InverseTransformVector(WorldCenter(visual.rectTransform) - WorldCenter(arrow));
            arrow.anchoredPosition -= new Vector2(drift.x, drift.y);
        }

        private static Image LargestImage(RectTransform root)
        {
            Image best = null;
            float bestArea = 0f;
            foreach (var image in root.GetComponentsInChildren<Image>(true))
            {
                var size = image.rectTransform.rect.size;
                float area = size.x * size.y;
                if (area > bestArea) { best = image; bestArea = area; }
            }
            return best;
        }

        private static Vector3 WorldCenter(RectTransform rt)
        {
            var corners = new Vector3[4];
            rt.GetWorldCorners(corners);
            return (corners[0] + corners[2]) * 0.5f;
        }

        /// <summary>Also select/deselect modded strains from the screen's Select all / Deselect all buttons.</summary>
        private void HookBulkButton(Transform button, string vanillaMethod, Action action)
        {
            if (!button) return;
            foreach (var trigger in button.GetComponentsInChildren<EventTrigger>(true))
            {
                if (trigger.triggers == null) continue;
                foreach (var entry in trigger.triggers)
                {
                    var callback = entry?.callback;
                    if (callback == null) continue;
                    for (int i = 0; i < callback.GetPersistentEventCount(); i++)
                    {
                        if (callback.GetPersistentMethodName(i) != vanillaMethod) continue;
                        UnityAction<BaseEventData> listener = _ => action();
                        callback.AddListener(listener);
                        _hooks.Add(new KeyValuePair<UnityEvent<BaseEventData>, UnityAction<BaseEventData>>(callback, listener));
                        return;
                    }
                }
            }
        }

        // ----- pages ----------------------------------------------------------

        private void Turn(int delta)
        {
            if (_cards.Count == 0) return;
            AudioManager.Play(AudioEvents.UI_Toggle, loop: false, UnityEngine.Random.Range(0.9f, 1.1f));
            int n = PageCount;
            ShowPage(((_page + delta) % n + n) % n);
        }

        private void ShowPage(int page)
        {
            if (page != 0 && _page == 0)
            {
                // Leaving the game's page: remember its (translated) texts to put back.
                _vanillaHeader = _header.text;
                _vanillaExplanation = _explanation ? _explanation.text : null;
            }
            _page = page;

            bool modded = page > 0 && _modGrid;
            _grid.gameObject.SetActive(!modded);
            if (_modGrid) _modGrid.gameObject.SetActive(modded);

            if (!modded)
            {
                if (_vanillaHeader != null) _header.text = _vanillaHeader;
                if (_explanation && _vanillaExplanation != null) _explanation.text = _vanillaExplanation;
                return;
            }

            int first = (page - 1) * PageSize;
            int shown = 0;
            for (int i = 0; i < _cards.Count; i++)
            {
                bool on = i >= first && i < first + PageSize;
                if (on) { shown++; _cards[i].Refresh(animate: false); }
                else _cards[i].HideInfoNow();
                _cards[i].gameObject.SetActive(on);
            }
            for (int i = 0; i < _spacers.Count; i++) _spacers[i].SetActive(i < PageSize - shown);

            int moddedPages = PageCount - 1;
            _header.text = moddedPages > 1 ? $"{ModdedTitle} {page}/{moddedPages}" : ModdedTitle;
            if (_explanation) _explanation.text = ModdedExplanation;
        }
    }

    /// <summary>
    /// One modded strain's card: a clone of the game's StrainButton with the vanilla
    /// component replaced. Mirrors StrainButton's look and feel (the check pops in, the
    /// card swaps to its "on" sprite, the tooltip swings in on hover) but toggles the
    /// player's pick for a modded strain.
    /// </summary>
    internal sealed class ModStrainCard : MonoBehaviour
    {
        private StrainDefinition _def;
        private Transform _check;
        private Image _buttonImage;
        private Sprite _enabledSprite;
        private Sprite _disabledSprite;
        private Image _image;
        private Transform _info;

        internal string Id => _def?.Id;

        internal static ModStrainCard Create(StrainButton template, Transform parent, StrainDefinition def)
        {
            GameObject go = null;
            try
            {
                go = CardSurgery.CloneInactive(template.gameObject, parent, "ModStrain " + def.Id);
                var vanilla = go.GetComponent<StrainButton>();
                var card = go.AddComponent<ModStrainCard>();
                card._def = def;
                card._check = CardSurgery.Field<Transform>(vanilla, "m_Check");
                card._buttonImage = CardSurgery.Field<Image>(vanilla, "m_ButtonImage");
                card._enabledSprite = CardSurgery.Field<Sprite>(vanilla, "m_EnableButton");
                card._disabledSprite = CardSurgery.Field<Sprite>(vanilla, "m_DisableButton");
                card._image = CardSurgery.Field<Image>(vanilla, "m_Image");
                card._info = CardSurgery.Field<Transform>(vanilla, "m_Info");
                var cost = CardSurgery.Field<TMP_Text>(vanilla, "m_TextCost");
                var name = CardSurgery.Field<TMP_Text>(vanilla, "m_StrainName");
                var description = CardSurgery.Field<TMP_Text>(vanilla, "m_StrainDescription");
                var chain = CardSurgery.Field<GameObject>(vanilla, "m_LockedChain");

                // Route the card's own EventTrigger wiring (StrainButton.OnClick/Show/Hide)
                // to us, and mute anything that points outside the card.
                foreach (var trigger in go.GetComponentsInChildren<EventTrigger>(true))
                {
                    if (trigger.triggers == null) continue;
                    foreach (var entry in trigger.triggers)
                        CardSurgery.Redirect(entry, vanilla, go.transform, card);
                }
                DestroyImmediate(vanilla);

                var icon = go.transform.Find("Visual/Icon");
                var iconImage = icon ? icon.GetComponent<Image>() : null;
                if (iconImage) iconImage.sprite = StrainIcons.For(def);
                if (cost) cost.text = def.Heat.ToString();
                if (name) name.text = def.Name;
                if (description) description.text = Rewrite(def.Description);
                if (chain) chain.SetActive(false);
                if (card._info) card._info.localScale = Vector3.zero;

                go.SetActive(true);
                card.Refresh(animate: false);
                return card;
            }
            catch (Exception ex)
            {
                StrainCore.Log($"could not make a card for '{def.Id}': {ex}");
                if (go) Destroy(go);
                return null;
            }
        }

        private static string Rewrite(string description)
        {
            if (string.IsNullOrEmpty(description)) return "";
            try { return SingletonMonoBehaviour<LocalizationManager>.Instance.RewriteDescription(description); }
            catch { return description; }
        }

        internal void Refresh(bool animate)
        {
            if (_def == null) return;
            bool on = StrainCore.IsSelected(_def.Id);
            if (_buttonImage) _buttonImage.sprite = on ? _enabledSprite : _disabledSprite;
            if (!_check) return;
            _check.DOKill();
            var scale = on ? Vector3.one : Vector3.zero;
            if (!animate || !isActiveAndEnabled) _check.localScale = scale;
            else if (on) _check.DOScale(scale, 0.15f).SetEase(Ease.OutBack);
            else _check.DOScale(scale, 0.1f);
        }

        public void OnClick()
        {
            if (_def == null) return;
            AudioManager.Play(AudioEvents.UI_Toggle, loop: false, UnityEngine.Random.Range(0.9f, 1.1f));
            // Any change of the picks refreshes every card (an incompatible strain may be
            // unpicked too) and the heat, through StrainCore.SelectionChanged.
            StrainCore.SetSelected(_def, !StrainCore.IsSelected(_def.Id));
        }

        public void Show()
        {
            if (!_info) return;
            AudioManager.Play(AudioEvents.UI_ButtonCollection, loop: false, UnityEngine.Random.Range(0.9f, 1.2f));
            if (_image) _image.DOKill();
            _info.DOKill();
            _info.localRotation = Quaternion.Euler(0f, 0f, 20f);
            _info.DOLocalRotate(Vector3.zero, 0.65f).SetEase(Ease.OutBack);
            _info.DOScale(Vector3.one, 0.25f).SetEase(Ease.OutBack);
        }

        public void Hide()
        {
            if (!_info) return;
            if (_image) _image.DOKill();
            _info.DOKill();
            _info.DOScale(Vector3.zero, 0.25f).SetEase(Ease.OutBack);
        }

        internal void HideInfoNow()
        {
            if (!_info) return;
            _info.DOKill();
            _info.localScale = Vector3.zero;
        }

        private void OnDestroy()
        {
            if (_check) _check.DOKill();
            if (_info) _info.DOKill();
        }
    }

    /// <summary>What it takes to turn one of the game's buttons into one of ours.</summary>
    internal static class CardSurgery
    {
        /// <summary>
        /// Instantiate <paramref name="source"/> under an inactive holder - so none of its
        /// components wake up (the gamepad selectable would register itself with the
        /// screen's navigation) - strip the selection plumbing, then move it under
        /// <paramref name="parent"/>, still inactive.
        /// </summary>
        internal static GameObject CloneInactive(GameObject source, Transform parent, string name)
        {
            var holder = new GameObject("StrainApi_Staging");
            holder.SetActive(false);
            try
            {
                var clone = UnityEngine.Object.Instantiate(source, holder.transform, false);
                clone.name = name;
                // Dependents first (SelectFeedback and friends), then the Selectables they may require.
                foreach (var mb in clone.GetComponentsInChildren<MonoBehaviour>(true))
                {
                    if (!mb || mb is Selectable) continue;
                    var typeName = mb.GetType().Name;
                    if (typeName.Contains("Rewired") || typeName == "SelectFeedback") UnityEngine.Object.DestroyImmediate(mb);
                }
                foreach (var selectable in clone.GetComponentsInChildren<Selectable>(true))
                    if (selectable) UnityEngine.Object.DestroyImmediate(selectable);
                clone.SetActive(false);
                clone.transform.SetParent(parent, false);
                return clone;
            }
            finally { UnityEngine.Object.DestroyImmediate(holder); }
        }

        internal static T Field<T>(object target, string name) where T : class
        {
            var field = target?.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance);
            return field?.GetValue(target) as T;
        }

        /// <summary>Turn off every persistent listener aimed outside <paramref name="root"/>. True if there was one.</summary>
        internal static bool MuteExternal(EventTrigger.Entry entry, Transform root)
        {
            var callback = entry?.callback;
            if (callback == null) return false;
            bool muted = false;
            for (int i = 0; i < callback.GetPersistentEventCount(); i++)
            {
                if (IsInside(callback.GetPersistentTarget(i), root)) continue;
                callback.SetPersistentListenerState(i, UnityEventCallState.Off);
                muted = true;
            }
            return muted;
        }

        /// <summary>
        /// StrainButton.OnClick/Show/Hide calls become the card's; anything aimed outside the
        /// card is muted. The card's hover and press feedback (RotationButton, ShadowButton)
        /// keeps its own listeners.
        /// </summary>
        internal static void Redirect(EventTrigger.Entry entry, StrainButton vanilla, Transform root, ModStrainCard card)
        {
            var callback = entry?.callback;
            if (callback == null) return;
            for (int i = 0; i < callback.GetPersistentEventCount(); i++)
            {
                var target = callback.GetPersistentTarget(i);
                if (target == vanilla)
                {
                    callback.SetPersistentListenerState(i, UnityEventCallState.Off);
                    switch (callback.GetPersistentMethodName(i))
                    {
                        case nameof(StrainButton.OnClick): callback.AddListener(_ => card.OnClick()); break;
                        case nameof(StrainButton.Show):    callback.AddListener(_ => card.Show()); break;
                        case nameof(StrainButton.Hide):    callback.AddListener(_ => card.Hide()); break;
                    }
                }
                else if (!IsInside(target, root))
                    callback.SetPersistentListenerState(i, UnityEventCallState.Off);
            }
        }

        private static bool IsInside(UnityEngine.Object target, Transform root)
        {
            if (target is Component c) return c && c.transform.IsChildOf(root);
            if (target is GameObject g) return g && g.transform.IsChildOf(root);
            return false;
        }
    }
}
