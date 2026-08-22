using System;
using System.Collections.Generic;
using System.Reflection;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Gambonanza.GameUI
{
    /// <summary>
    /// Public factory for game-styled UI. Every method is safe to call from any
    /// scene; if the underlying game UI hasn't been instantiated yet, the factory
    /// falls back to a programmatic approximation so your mod stays usable.
    ///
    /// Templates are captured once on first use and cached for the rest of the
    /// session. The first call to a given factory may be slightly slower; subsequent
    /// calls are cheap clones.
    /// </summary>
    public static class Pixel
    {
        // ============================================================
        // Buttons
        // ============================================================

        /// <summary>
        /// Create a game-styled button as a child of <paramref name="parent"/>.
        /// Cloned from a CanvasMenu home-row button cell when possible; otherwise
        /// a programmatic cream button.
        /// </summary>
        public static Button CreateButton(Transform parent, string label, Action onClick)
        {
            if (parent == null) throw new ArgumentNullException(nameof(parent));

            var template = Templates.GetButtonTemplate(out var labelPath);
            return template != null
                ? CreateButtonFromTemplate(parent, label, onClick, template, labelPath)
                : CreateButtonProgrammatic(parent, label, onClick);
        }

        private static Button CreateButtonFromTemplate(
            Transform parent, string label, Action onClick,
            GameObject template, List<int> labelPath)
        {
            var clone = UnityEngine.Object.Instantiate(template, parent);
            clone.SetActive(true);
            clone.name = "Pixel_Button_" + (label ?? "");

            // Retext label.
            TMP_Text lbl = null;
            if (labelPath != null) lbl = Hierarchy.NavigatePath(clone.transform, labelPath)?.GetComponent<TMP_Text>();
            if (lbl == null) lbl = clone.GetComponentInChildren<TMP_Text>(true);
            if (lbl != null) lbl.text = label ?? "";

            // Wire a fresh Button. Preserve the original Image colour - the cell
            // sprite is white pixels tinted cream by Image.color; resetting to
            // white would wash it out and make the button look pure white instead
            // of the game's signature cream.
            var img = clone.GetComponent<Image>() ?? clone.GetComponentInChildren<Image>(true);
            if (img != null) img.raycastTarget = true;

            var btn = clone.GetComponent<Button>() ?? clone.AddComponent<Button>();
            btn.interactable = true;
            if (img != null) btn.targetGraphic = img;
            // No ColorTint: every vanilla menu button hovers by scaling (RotationButton,
            // preserved in the template) - a tint on top reads as foreign. The Button here
            // only carries onClick; it coexists with the template's EventTrigger.
            btn.transition = Selectable.Transition.None;
            btn.onClick.RemoveAllListeners();
            btn.onClick.AddListener(() => Safe.Invoke(onClick));
            return btn;
        }

        private static Button CreateButtonProgrammatic(Transform parent, string label, Action onClick)
        {
            var go = NewChild(parent, "Pixel_Button_" + (label ?? ""), typeof(Image), typeof(Button));
            go.GetComponent<Image>().color = new Color(1f, 1f, 1f, 0.6f);

            var btn = go.GetComponent<Button>();
            ButtonStyle.ApplyDefaultColors(btn);
            btn.onClick.AddListener(() => Safe.Invoke(onClick));

            var lbl = CreateLabel(go.transform, label ?? "", 18,
                new Color(0.36f, 0.13f, 0.11f, 1f), TextAlignmentOptions.Center);
            StretchFull((RectTransform)lbl.transform);
            return btn;
        }

        // ============================================================
        // Toggles
        // ============================================================

        /// <summary>
        /// Create a two-state button. The label flips between "{name}: ON" and "{name}: OFF"
        /// (or just "ON"/"OFF" if you pass a null/empty name).
        /// </summary>
        public static PixelToggle CreateToggle(Transform parent, string baseLabel, bool initialOn, Action<bool> onChange)
        {
            var btn = CreateButton(parent, baseLabel ?? "", null);   // we wire onClick ourselves below
            var lbl = btn != null ? btn.GetComponentInChildren<TMP_Text>(true) : null;
            return new PixelToggle(btn, lbl, baseLabel, initialOn, onChange);
        }

        // ============================================================
        // Checkboxes (settings-menu style)
        // ============================================================

        /// <summary>
        /// Create a small square game-styled checkbox widget - cream box with a
        /// centered dark checkmark glyph that hides when off. The box sprite
        /// and the checkmark sprite are scraped from a live Settings Toggle
        /// when possible (so the visual matches the rest of the menu); both
        /// fall back to flat-colour rectangles otherwise.
        ///
        /// The widget pins itself to a fixed 40x40 LayoutElement and centers
        /// the checkmark glyph at 26x26 with preserveAspect - independent of
        /// any outer layout group so the row can't stretch the visual.
        /// PixelCheckbox.Label is always null; callers supply their own label
        /// in the surrounding row.
        /// </summary>
        public static PixelCheckbox CreateCheckbox(
            Transform parent, string label, bool initialOn, Action<bool> onChange)
        {
            if (parent == null) throw new ArgumentNullException(nameof(parent));

            const float BoxDim   = 40f;
            const float CheckDim = 26f;

            Templates.TryGetCheckboxSprites(
                out var boxSprite, out var boxColor,
                out var checkSprite, out var checkColor);

            // Box (root): square, fixed size, hosts the click target.
            var box = NewChild(parent, "Pixel_Checkbox_" + (label ?? ""),
                typeof(Image), typeof(Button), typeof(LayoutElement));
            var boxRT = box.GetComponent<RectTransform>();
            boxRT.sizeDelta = new Vector2(BoxDim, BoxDim);
            var le = box.GetComponent<LayoutElement>();
            le.preferredWidth  = BoxDim;
            le.preferredHeight = BoxDim;
            le.minWidth        = BoxDim;
            le.minHeight       = BoxDim;
            le.flexibleWidth   = 0f;
            le.flexibleHeight  = 0f;

            var boxImg = box.GetComponent<Image>();
            if (boxSprite != null)
            {
                boxImg.sprite = boxSprite;
                // Sliced uses the sprite's 9-slice border data when present; if
                // not, it falls back to stretching the sprite, which is fine for
                // a 40x40 cell.
                boxImg.type = Image.Type.Sliced;
            }
            boxImg.color = boxColor.a > 0f ? boxColor : new Color(0.92f, 0.86f, 0.66f, 1f);
            boxImg.raycastTarget = true;

            var btn = box.GetComponent<Button>();
            btn.interactable = true;
            btn.targetGraphic = boxImg;
            ButtonStyle.ApplyDefaultColors(btn);

            // Checkmark: centered, fixed size, preserveAspect so the captured
            // sprite never stretches.
            var checkGo = new GameObject("Check", typeof(RectTransform), typeof(Image));
            checkGo.transform.SetParent(box.transform, false);
            var checkRT = checkGo.GetComponent<RectTransform>();
            checkRT.anchorMin = checkRT.anchorMax = new Vector2(0.5f, 0.5f);
            checkRT.pivot     = new Vector2(0.5f, 0.5f);
            checkRT.anchoredPosition = Vector2.zero;
            checkRT.sizeDelta = new Vector2(CheckDim, CheckDim);
            var checkImg = checkGo.GetComponent<Image>();
            if (checkSprite != null)
            {
                checkImg.sprite = checkSprite;
                checkImg.preserveAspect = true;
            }
            checkImg.color = checkColor.a > 0f ? checkColor : new Color(0.36f, 0.13f, 0.11f, 1f);
            checkImg.raycastTarget = false;

            var checkbox = new PixelCheckbox(box, null, checkGo, label, initialOn, onChange);
            btn.onClick.RemoveAllListeners();
            btn.onClick.AddListener(() => checkbox.Set(!checkbox.IsOn));
            return checkbox;
        }

        // ============================================================
        // Labels
        // ============================================================

        /// <summary>
        /// Programmatic TMP label. Uses the best non-fallback font found in the
        /// current scene (typically the game's pixel font).
        /// </summary>
        public static TMP_Text CreateLabel(
            Transform parent, string text, float size,
            Color? color = null, TextAlignmentOptions align = TextAlignmentOptions.Center)
        {
            if (parent == null) throw new ArgumentNullException(nameof(parent));

            var go = new GameObject("Pixel_Label", typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var tmp = go.AddComponent<TextMeshProUGUI>();
            tmp.text          = text ?? "";
            tmp.fontSize      = size;
            tmp.color         = color ?? new Color(0.36f, 0.13f, 0.11f, 1f);
            tmp.alignment     = align;
            tmp.font          = Templates.BestFont();
            tmp.raycastTarget = false;
            return tmp;
        }

        /// <summary>The best non-fallback TMP font in the loaded scene, or null.</summary>
        public static TMP_FontAsset FindBestFont() => Templates.BestFont();

        // ============================================================
        // Modals
        // ============================================================

        /// <summary>
        /// Create a modal whose chrome matches the in-game Settings panel when
        /// possible. Returns a <see cref="Modal"/> handle exposing Title, Content,
        /// Toolbar, Status, Show, Hide, AddToolbarButton.
        ///
        /// The modal starts hidden - call <see cref="Modal.Show"/> when ready.
        /// </summary>
        public static Modal CreateModal(string name, string title)
        {
            Log.Line("CreateModal entry: " + (name ?? "<null>"));
            var settings = Hierarchy.FindByTypeFullName("Blukulele.CHE.SettingsCanvas");
            if (settings == null)
            {
                Log.Line("CreateModal: no live SettingsCanvas - programmatic fallback");
                return CreateModalProgrammatic(name, title);
            }
            try
            {
                Log.Line("CreateModal: cloning live Settings Window panel");
                return CreateModalFromLiveSettings(name, title, settings);
            }
            catch (System.Exception ex)
            {
                Log.Line("CreateModal: live clone threw, programmatic fallback: " + ex);
                return CreateModalProgrammatic(name, title);
            }
        }

        private static Modal CreateModalFromLiveSettings(string name, string title, MonoBehaviour settings)
        {
            const BindingFlags F = BindingFlags.NonPublic | BindingFlags.Instance;
            var t = settings.GetType();

            var header       = (t.GetField("m_TextHeader",        F)?.GetValue(settings)) as TMP_Text;
            var gameplayCont = (t.GetField("m_GameplayContainer", F)?.GetValue(settings)) as GameObject;
            if (header == null || gameplayCont == null)
            {
                Log.Line("CreateModalLive: m_TextHeader / m_GameplayContainer missing");
                return CreateModalProgrammatic(name, title);
            }

            // The visible cream chrome is "Settings Window" - the parent of the
            // gameplay container. Clone JUST that piece (not the whole CNV_Settings
            // root with its Witch / TwitchBackground / animation anchors).
            var panel = gameplayCont.transform.parent;
            if (panel == null)
            {
                Log.Line("CreateModalLive: gameplay container has no parent");
                return CreateModalProgrammatic(name, title);
            }

            // Resolve every landmark + destruction target relative to the panel
            // BEFORE cloning, then re-resolve them in the clone. Sibling indices
            // can't shift because we only destroy after all paths are walked.
            var headerPath       = Hierarchy.PathFromAncestor(panel, header.transform);
            var gameplayContPath = Hierarchy.PathFromAncestor(panel, gameplayCont.transform);

            // Tab containers + tab buttons are discovered by shape, not by name - see
            // SettingsTabs. Anything the game adds later gets stripped automatically.
            var destroyPaths = new List<List<int>>();
            void AddP(Transform tr) { if (tr != null) destroyPaths.Add(Hierarchy.PathFromAncestor(panel, tr)); }

            var discardable = SettingsTabs.DiscardableTargets(settings);
            foreach (var tr in discardable) AddP(tr);
            Log.Line($"CreateModalLive: queued {discardable.Count} reflected tab/container destroy(s)");

            // Holder GameObject + a fresh Overlay canvas of our own. The cloned
            // panel becomes a child of this canvas - no SettingsCanvas state to
            // inherit, no sub-canvas confusion, no CanvasGroup ghosts.
            var holder = new GameObject(name ?? "Pixel_Modal");
            UnityEngine.Object.DontDestroyOnLoad(holder);
            holder.hideFlags = HideFlags.HideAndDontSave;
            holder.SetActive(false);                 // user calls Show()

            var canvasGo = NewChild(holder.transform, "Canvas",
                typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
            var canvas = canvasGo.GetComponent<Canvas>();

            // Copy the live SettingsCanvas's Canvas settings so we render in the
            // same layer (above the CRT post-process). Forcing ScreenSpaceOverlay
            // would push us BEHIND the CRT shader, which is exactly what we want
            // to avoid.
            var origCanvas = settings.GetComponent<Canvas>()
                          ?? settings.GetComponentInParent<Canvas>();
            if (origCanvas != null)
            {
                canvas.renderMode       = origCanvas.renderMode;
                canvas.worldCamera      = origCanvas.worldCamera;
                canvas.planeDistance    = origCanvas.planeDistance;
                canvas.sortingLayerName = origCanvas.sortingLayerName;
                canvas.sortingOrder     = origCanvas.sortingOrder + 1;   // sit just above
                canvas.pixelPerfect     = origCanvas.pixelPerfect;
                canvas.additionalShaderChannels = origCanvas.additionalShaderChannels;
                Log.Line($"CreateModalLive: copied Canvas (mode={canvas.renderMode}, layer={canvas.sortingLayerName}, order={canvas.sortingOrder})");
            }
            else
            {
                canvas.renderMode   = RenderMode.ScreenSpaceOverlay;
                canvas.sortingOrder = 32760;
            }

            // Match the original CanvasScaler so our cloned 1200x800 panel scales
            // identically to how Settings would be drawn.
            var scaler     = canvasGo.GetComponent<CanvasScaler>();
            var origScaler = settings.GetComponent<CanvasScaler>()
                          ?? settings.GetComponentInParent<CanvasScaler>();
            if (origScaler != null)
            {
                scaler.uiScaleMode         = origScaler.uiScaleMode;
                scaler.referenceResolution = origScaler.referenceResolution;
                scaler.screenMatchMode     = origScaler.screenMatchMode;
                scaler.matchWidthOrHeight  = origScaler.matchWidthOrHeight;
                scaler.referencePixelsPerUnit = origScaler.referencePixelsPerUnit;
                scaler.scaleFactor         = origScaler.scaleFactor;
            }
            else
            {
                scaler.uiScaleMode         = CanvasScaler.ScaleMode.ScaleWithScreenSize;
                scaler.referenceResolution = new Vector2(1920, 1080);
                scaler.matchWidthOrHeight  = 0.5f;
            }

            // Backdrop: dim the world behind the panel and let click-outside close.
            Modal modalRef = null;
            var backdrop = NewChild(canvasGo.transform, "Backdrop", typeof(Image), typeof(Button));
            StretchFull((RectTransform)backdrop.transform);
            backdrop.GetComponent<Image>().color = new Color(0f, 0f, 0f, 0.7f);
            var backdropBtn = backdrop.GetComponent<Button>();
            ButtonStyle.ApplyDefaultColors(backdropBtn);
            backdropBtn.onClick.AddListener(() => modalRef?.Hide());

            // Clone the Settings Window panel and re-anchor it to the centre of the canvas
            // at its original size, so layout doesn't depend on the original parent chain.
            var clonedPanel = UnityEngine.Object.Instantiate(panel.gameObject, canvasGo.transform);
            clonedPanel.name = "Pixel_ModalPanel";
            clonedPanel.SetActive(true);

            var origRT   = panel as RectTransform;
            var clonedRT = clonedPanel.GetComponent<RectTransform>();
            if (clonedRT != null)
            {
                clonedRT.anchorMin = clonedRT.anchorMax = new Vector2(0.5f, 0.5f);
                clonedRT.pivot     = new Vector2(0.5f, 0.5f);
                clonedRT.anchoredPosition = Vector2.zero;
                clonedRT.localScale       = Vector3.one;
                clonedRT.localRotation    = Quaternion.identity;
                if (origRT != null)
                    clonedRT.sizeDelta = new Vector2(origRT.rect.width, origRT.rect.height);
            }

            // Strip every interactive component on the clone (Selectables, EventTriggers,
            // Blukulele MBs, custom Button/Feedback/Rewired classes).
            int stripped = Strip.Interactives(clonedPanel);
            Log.Line($"CreateModalLive: stripped {stripped} comps from cloned panel");

            // Resolve destroy targets in the CLONE (paths still valid; we haven't
            // destroyed anything yet), then drop them all in a second pass.
            var resolved = new List<Transform>();
            foreach (var p in destroyPaths)
            {
                var tr = Hierarchy.NavigatePath(clonedPanel.transform, p);
                if (tr != null) resolved.Add(tr);
            }
            foreach (var tr in resolved)
                if (tr != null) UnityEngine.Object.DestroyImmediate(tr.gameObject);
            Log.Line($"CreateModalLive: destroyed {resolved.Count} unwanted nodes");

            // Diagnostic: list every direct child of the cloned panel that survived.
            // If something unwanted bleeds through (a future Settings tab whose field
            // doesn't follow the m_*Container / m_*Button naming), it shows up here
            // and we can decide whether to add a smarter filter.
            for (int i = 0; i < clonedPanel.transform.childCount; i++)
            {
                var ch = clonedPanel.transform.GetChild(i);
                Log.Line($"CreateModalLive: panel child[{i}] '{ch.name}' active={ch.gameObject.activeSelf}");
            }

            // Force every remaining GameObject + Canvas + CanvasGroup to be visible.
            foreach (var trA in clonedPanel.GetComponentsInChildren<Transform>(true))
                if (trA != null && trA.gameObject != null) trA.gameObject.SetActive(true);
            foreach (var c in clonedPanel.GetComponentsInChildren<Canvas>(true))
                if (c != null) { c.enabled = true; }
            foreach (var cg in clonedPanel.GetComponentsInChildren<CanvasGroup>(true))
            {
                if (cg == null) continue;
                cg.alpha              = 1f;
                cg.interactable       = true;
                cg.blocksRaycasts     = true;
                cg.ignoreParentGroups = false;
            }

            // Retitle the header.
            var clonedHeader = Hierarchy.NavigatePath(clonedPanel.transform, headerPath)?.GetComponent<TMP_Text>();
            if (clonedHeader != null) clonedHeader.text = title ?? "";

            // Use the cloned gameplay container as the content area - clear it and
            // give it a vertical layout for callers to populate.
            var contentT = Hierarchy.NavigatePath(clonedPanel.transform, gameplayContPath);
            if (contentT == null)
            {
                Log.Line("CreateModalLive: cloned gameplay container missing - fallback");
                UnityEngine.Object.Destroy(holder);
                return CreateModalProgrammatic(name, title);
            }
            for (int i = contentT.childCount - 1; i >= 0; i--)
                UnityEngine.Object.DestroyImmediate(contentT.GetChild(i).gameObject);
            EnsureVerticalLayout(contentT);

            // Status + toolbar live INSIDE the panel, anchored to its bottom.
            var status  = BuildStatusLine(clonedPanel.transform);
            var toolbar = BuildToolbar(clonedPanel.transform);

            // Wire the Close_Button (the X in the top-right) to Hide if it survived.
            // Preserve its original Image colour - the close button has its own
            // baked-in cream sprite tint.
            var closeT = Hierarchy.FindChildByName(clonedPanel.transform, "Close_Button");
            if (closeT != null)
            {
                var img = closeT.GetComponent<Image>() ?? closeT.GetComponentInChildren<Image>(true);
                if (img != null) img.raycastTarget = true;
                var existing = closeT.GetComponent<Button>();
                if (existing != null) UnityEngine.Object.DestroyImmediate(existing);
                var closeBtn = closeT.gameObject.AddComponent<Button>();
                closeBtn.interactable = true;
                if (img != null) closeBtn.targetGraphic = img;
                ButtonStyle.ApplyDefaultColors(closeBtn);
                closeBtn.onClick.AddListener(() => modalRef?.Hide());
            }

            modalRef = new Modal(holder, contentT, clonedHeader, toolbar, status);
            return modalRef;
        }

        private static Modal CreateModalFromTemplate(
            string name, string title,
            GameObject template, List<int> titlePath, List<int> contentPath)
        {
            // Manager GameObject under DontDestroyOnLoad so the modal survives scene loads.
            var holder = new GameObject(name ?? "Pixel_Modal");
            UnityEngine.Object.DontDestroyOnLoad(holder);
            holder.hideFlags = HideFlags.HideAndDontSave;

            var clone = UnityEngine.Object.Instantiate(template, holder.transform);
            clone.name = (name ?? "Pixel_Modal") + "_Clone";
            clone.SetActive(false);                  // user calls Show() to reveal

            // ── Force the entire clone visible. The captured SettingsCanvas was
            //    inactive when we cloned it (Settings closed), so any combination of:
            //      - Canvas component disabled
            //      - Sub-GameObjects inactive (e.g. the visible "panel" child)
            //      - CanvasGroup alpha=0 / interactable=false
            //    will render the modal invisible. Override every one explicitly.

            // 1. Activate every GameObject in the clone subtree (we already stripped
            //    everything we didn't want, so anything still here should be visible).
            foreach (var tr in clone.GetComponentsInChildren<Transform>(true))
                if (tr != null && tr.gameObject != null) tr.gameObject.SetActive(true);
            // (clone itself is left to the caller's Show()/Hide().)
            clone.SetActive(false);

            // 2. Force every Canvas in the subtree to render on top.
            var canvases = clone.GetComponentsInChildren<Canvas>(true);
            Log.Line($"modal clone has {canvases.Length} Canvas component(s).");
            foreach (var c in canvases)
            {
                if (c == null) continue;
                c.enabled         = true;
                c.overrideSorting = true;
                c.renderMode      = RenderMode.ScreenSpaceOverlay;
                c.sortingOrder    = 32760;
            }
            var canvas = canvases.Length > 0 ? canvases[0] : null;
            if (canvas == null)
            {
                Log.Line("modal clone has NO Canvas - promoting clone root.");
                canvas = clone.AddComponent<Canvas>();
                canvas.renderMode   = RenderMode.ScreenSpaceOverlay;
                canvas.sortingOrder = 32760;
            }

            // 3. Make sure the canvas can receive clicks AND scale to screen.
            foreach (var c in clone.GetComponentsInChildren<Canvas>(true))
            {
                if (c == null) continue;
                if (c.GetComponent<GraphicRaycaster>() == null)
                    c.gameObject.AddComponent<GraphicRaycaster>();
                else
                    c.GetComponent<GraphicRaycaster>().enabled = true;

                var scaler = c.GetComponent<CanvasScaler>();
                if (scaler == null)
                {
                    scaler = c.gameObject.AddComponent<CanvasScaler>();
                    scaler.uiScaleMode         = CanvasScaler.ScaleMode.ScaleWithScreenSize;
                    scaler.referenceResolution = new Vector2(1920, 1080);
                    scaler.matchWidthOrHeight  = 0.5f;
                }
                else { scaler.enabled = true; }
            }

            // 4. Force every CanvasGroup to interactive + visible.
            foreach (var cg in clone.GetComponentsInChildren<CanvasGroup>(true))
            {
                if (cg == null) continue;
                cg.alpha              = 1f;
                cg.interactable       = true;
                cg.blocksRaycasts     = true;
                cg.ignoreParentGroups = false;
            }

            var titleTmp = Hierarchy.NavigatePath(clone.transform, titlePath)?.GetComponent<TMP_Text>();
            if (titleTmp != null) titleTmp.text = title ?? "";

            var content = Hierarchy.NavigatePath(clone.transform, contentPath);
            if (content == null) { Log.Line("modal content path navigation failed; programmatic fallback."); return CreateModalProgrammatic(name, title); }

            // Ensure content has a vertical layout so user adds populate top-to-bottom.
            EnsureVerticalLayout(content);

            // Build status + toolbar overlays anchored to the bottom of the panel.
            var panel = content.parent;
            var status  = BuildStatusLine(panel);
            var toolbar = BuildToolbar(panel);

            return new Modal(clone, content, titleTmp, toolbar, status);
        }

        private static Modal CreateModalProgrammatic(string name, string title)
        {
            // Backdrop + cream panel on a fresh overlay canvas.
            var holder = new GameObject(name ?? "Pixel_Modal");
            UnityEngine.Object.DontDestroyOnLoad(holder);
            holder.hideFlags = HideFlags.HideAndDontSave;

            var canvasGo = NewChild(holder.transform, "Canvas", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
            canvasGo.SetActive(false);
            var canvas = canvasGo.GetComponent<Canvas>();
            canvas.renderMode   = RenderMode.ScreenSpaceOverlay;
            canvas.sortingOrder = 32000;
            var scaler = canvasGo.GetComponent<CanvasScaler>();
            scaler.uiScaleMode        = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920, 1080);
            scaler.matchWidthOrHeight = 0.5f;

            var backdrop = NewChild(canvasGo.transform, "Backdrop", typeof(Image), typeof(Button));
            StretchFull((RectTransform)backdrop.transform);
            backdrop.GetComponent<Image>().color = new Color(0f, 0f, 0f, 0.65f);
            // backdrop click closes the modal - escape hatch so users never get trapped
            // in a half-built or input-blocked state.
            var backdropBtn = backdrop.GetComponent<Button>();
            ButtonStyle.ApplyDefaultColors(backdropBtn);
            backdropBtn.onClick.AddListener(() => canvasGo.SetActive(false));

            var panel = NewChild(canvasGo.transform, "Panel", typeof(Image));
            var prt = (RectTransform)panel.transform;
            prt.anchorMin = prt.anchorMax = new Vector2(0.5f, 0.5f);
            prt.pivot     = new Vector2(0.5f, 0.5f);
            prt.sizeDelta = new Vector2(720, 560);
            panel.GetComponent<Image>().color = new Color(0.96f, 0.92f, 0.78f, 1f);

            var titleTmp = CreateLabel(panel.transform, title ?? "", 36,
                new Color(0.36f, 0.13f, 0.11f, 1f), TextAlignmentOptions.Top);
            var trt = (RectTransform)titleTmp.transform;
            trt.anchorMin = new Vector2(0, 1); trt.anchorMax = new Vector2(1, 1);
            trt.pivot = new Vector2(0.5f, 1); trt.sizeDelta = new Vector2(-40, 56);
            trt.anchoredPosition = new Vector2(0, -16);

            var content = new GameObject("Content", typeof(RectTransform), typeof(VerticalLayoutGroup), typeof(ContentSizeFitter));
            content.transform.SetParent(panel.transform, false);
            var crt = (RectTransform)content.transform;
            crt.anchorMin = new Vector2(0, 0); crt.anchorMax = new Vector2(1, 1);
            crt.offsetMin = new Vector2(20, 110);
            crt.offsetMax = new Vector2(-20, -80);
            EnsureVerticalLayout(content.transform);

            var status  = BuildStatusLine(panel.transform);
            var toolbar = BuildToolbar(panel.transform);

            return new Modal(canvasGo, content.transform, titleTmp, toolbar, status);
        }

        // ============================================================
        // Settings arrow row (patches the in-game settings)
        // ============================================================

        /// <summary>
        /// Append a "Title  &lt; value &gt;" row to the gameplay tab of an open
        /// <c>Blukulele.CHE.SettingsCanvas</c>. The row is cloned from the
        /// "Controls" cell so it inherits font, arrow art, and spacing.
        ///
        /// Idempotent: passing the same <paramref name="injectedName"/> returns the
        /// same row instead of stacking duplicates.
        ///
        /// Returns null if the SettingsCanvas isn't recognised.
        /// </summary>
        public static ArrowRow AddSettingsArrowRow(
            MonoBehaviour settingsCanvas,
            string injectedName,
            string title,
            string initialValue,
            Action onLeft,
            Action onRight)
        {
            if (settingsCanvas == null) return null;
            if (string.IsNullOrEmpty(injectedName)) injectedName = "Pixel_SettingsArrowRow";

            var template = Templates.GetArrowRowTemplate(
                out var titlePath, out var valuePath, out var leftPath, out var rightPath);
            if (template == null) { Log.Line("AddSettingsArrowRow: no arrow-row template; aborting."); return null; }

            // Find the wrapper sibling we need to slot next to. We do this by re-deriving
            // the live wrapper of m_ControlsTitle in the open SettingsCanvas - that's the
            // sibling whose layout the new row should mirror.
            const BindingFlags F = BindingFlags.NonPublic | BindingFlags.Instance;
            var t = settingsCanvas.GetType();
            var titleText = (t.GetField("m_ControlsTitle",   F)?.GetValue(settingsCanvas)) as TMP_Text;
            var valueText = (t.GetField("m_CurrentControls", F)?.GetValue(settingsCanvas)) as TMP_Text;
            if (titleText == null || valueText == null) { Log.Line("AddSettingsArrowRow: live controls fields missing."); return null; }

            Transform innerCell = Hierarchy.FindCommonAncestor(new[] { titleText.transform, valueText.transform });
            if (innerCell == null || innerCell.parent == null) { Log.Line("AddSettingsArrowRow: live controls cell missing."); return null; }
            if (innerCell == titleText.transform || innerCell == valueText.transform) innerCell = innerCell.parent;
            Transform sourceWrapper = innerCell.parent;
            if (sourceWrapper == null || sourceWrapper.parent == null) return null;
            Transform parent = sourceWrapper.parent;

            // Idempotency.
            var existing = parent.Find(injectedName);
            if (existing != null)
            {
                var et = Hierarchy.NavigatePath(existing, titlePath)?.GetComponent<TMP_Text>();
                var ev = Hierarchy.NavigatePath(existing, valuePath)?.GetComponent<TMP_Text>();
                if (et != null) et.text = title ?? "";
                if (ev != null) ev.text = initialValue ?? "";
                RewireArrowButtons(existing, leftPath, rightPath, onLeft, onRight);
                return new ArrowRow(existing.gameObject, et, ev);
            }

            // Instantiate from cached template (already stripped) and slot in after the source.
            var clone = UnityEngine.Object.Instantiate(template, parent);
            clone.name = injectedName;
            clone.SetActive(true);
            clone.transform.SetSiblingIndex(sourceWrapper.GetSiblingIndex() + 1);

            var clonedTitle = Hierarchy.NavigatePath(clone.transform, titlePath)?.GetComponent<TMP_Text>();
            var clonedValue = Hierarchy.NavigatePath(clone.transform, valuePath)?.GetComponent<TMP_Text>();
            if (clonedTitle != null) clonedTitle.text = title ?? "";
            if (clonedValue != null) clonedValue.text = initialValue ?? "";

            RewireArrowButtons(clone.transform, leftPath, rightPath, onLeft, onRight);

            // Shrink the row to ~60% of the source's height so we don't overflow into
            // the bottom checkbox strip.
            var srcLE = sourceWrapper.GetComponent<LayoutElement>();
            var srcRT = sourceWrapper.GetComponent<RectTransform>();
            float srcH = (srcLE != null && srcLE.preferredHeight > 0)
                ? srcLE.preferredHeight
                : (srcRT != null ? srcRT.rect.height : 60f);
            var injLE = clone.GetComponent<LayoutElement>() ?? clone.AddComponent<LayoutElement>();
            injLE.preferredHeight = srcH * 0.6f;
            injLE.minHeight       = srcH * 0.6f;

            return new ArrowRow(clone, clonedTitle, clonedValue);
        }

        private static void RewireArrowButtons(
            Transform rowRoot, List<int> leftPath, List<int> rightPath,
            Action onLeft, Action onRight)
        {
            var clonedLeft  = Hierarchy.NavigatePath(rowRoot, leftPath);
            var clonedRight = Hierarchy.NavigatePath(rowRoot, rightPath);

            foreach (var arrow in new[] { clonedLeft, clonedRight })
            {
                if (arrow == null) continue;
                var img = arrow.GetComponent<Image>();
                if (img != null) { img.color = Color.white; img.raycastTarget = true; }
            }
            if (clonedLeft  != null) AttachFreshButton(clonedLeft,  onLeft);
            if (clonedRight != null) AttachFreshButton(clonedRight, onRight);
        }

        private static void AttachFreshButton(Transform target, Action onClick)
        {
            var go = target.gameObject;
            var existing = go.GetComponent<Button>();
            if (existing != null) UnityEngine.Object.DestroyImmediate(existing);

            var graphic = go.GetComponent<Graphic>() ?? go.GetComponentInChildren<Graphic>(true);
            if (graphic != null) graphic.raycastTarget = true;

            var btn = go.AddComponent<Button>();
            btn.interactable = true;
            if (graphic != null) btn.targetGraphic = graphic;
            ButtonStyle.ApplyDefaultColors(btn);
            btn.onClick.AddListener(() => Safe.Invoke(onClick));
        }

        // ============================================================
        // Home menu button (patches the home screen)
        // ============================================================

        /// <summary>
        /// Add a button to the bottom row of <c>Blukulele.CHE.CanvasMenu</c> by
        /// cloning the Settings cell. Idempotent: if an injected sibling with
        /// <paramref name="injectedName"/> already exists, this is a no-op and
        /// returns null.
        /// </summary>
        public static Button AddHomeMenuButton(
            MonoBehaviour canvasMenu,
            string label,
            string injectedName,
            Action onClick)
        {
            if (canvasMenu == null) return null;
            if (string.IsNullOrEmpty(injectedName)) injectedName = "Pixel_HomeMenuButton";

            const BindingFlags F = BindingFlags.NonPublic | BindingFlags.Instance;
            var t = canvasMenu.GetType();
            var settingsText = (t.GetField("m_Text_Settings", F)?.GetValue(canvasMenu)) as TMP_Text;
            var quitText     = (t.GetField("m_Text_Quit",     F)?.GetValue(canvasMenu)) as TMP_Text;
            if (settingsText == null || quitText == null)
            {
                Log.Line("AddHomeMenuButton: CanvasMenu m_Text_Settings/m_Text_Quit missing.");
                return null;
            }

            var row = Hierarchy.FindCommonAncestor(new[] { settingsText.transform, quitText.transform });
            if (row == null) { Log.Line("AddHomeMenuButton: row missing."); return null; }

            Transform settingsCell = settingsText.transform;
            while (settingsCell != null && settingsCell.parent != row) settingsCell = settingsCell.parent;
            if (settingsCell == null) { Log.Line("AddHomeMenuButton: settings cell missing."); return null; }

            if (row.Find(injectedName) != null) return null;       // already injected

            // Use Pixel.CreateButton so we share the cached template + styling.
            var btn = CreateButton(row, label ?? "", onClick);
            if (btn == null) return null;
            btn.gameObject.name = injectedName;
            btn.transform.SetSiblingIndex(settingsCell.GetSiblingIndex() + 1);
            return btn;
        }

        // ============================================================
        // tiny shared primitives
        // ============================================================

        private static GameObject NewChild(Transform parent, string name, params Type[] components)
        {
            var go = new GameObject(name, typeof(RectTransform));
            foreach (var c in components) go.AddComponent(c);
            go.transform.SetParent(parent, false);
            return go;
        }

        private static void StretchFull(RectTransform rt)
        {
            rt.anchorMin = Vector2.zero; rt.anchorMax = Vector2.one;
            rt.offsetMin = Vector2.zero; rt.offsetMax = Vector2.zero;
        }

        private static void EnsureVerticalLayout(Transform t)
        {
            var vlg = t.GetComponent<VerticalLayoutGroup>() ?? t.gameObject.AddComponent<VerticalLayoutGroup>();
            vlg.padding             = new RectOffset(20, 20, 12, 12);
            vlg.spacing             = 8;
            vlg.childAlignment      = TextAnchor.UpperCenter;
            vlg.childControlWidth   = true;
            vlg.childControlHeight  = false;
            vlg.childForceExpandWidth  = true;
            vlg.childForceExpandHeight = false;
        }

        private static TMP_Text BuildStatusLine(Transform panel)
        {
            var status = CreateLabel(panel, "", 16,
                new Color(0.36f, 0.13f, 0.11f, 0.7f), TextAlignmentOptions.MidlineLeft);
            var rt = (RectTransform)status.transform;
            rt.anchorMin = new Vector2(0, 0); rt.anchorMax = new Vector2(1, 0);
            rt.pivot = new Vector2(0.5f, 0); rt.anchoredPosition = new Vector2(0, 60);
            rt.sizeDelta = new Vector2(-40, 22);
            status.gameObject.name = "Pixel_Status";
            return status;
        }

        private static Transform BuildToolbar(Transform panel)
        {
            var go = new GameObject("Pixel_Toolbar", typeof(RectTransform), typeof(HorizontalLayoutGroup));
            go.transform.SetParent(panel, false);
            var rt = (RectTransform)go.transform;
            rt.anchorMin = new Vector2(0, 0); rt.anchorMax = new Vector2(1, 0);
            rt.pivot = new Vector2(0.5f, 0); rt.anchoredPosition = new Vector2(0, 12);
            rt.sizeDelta = new Vector2(-40, 56);
            var hlg = go.GetComponent<HorizontalLayoutGroup>();
            hlg.spacing             = 12;
            hlg.childAlignment      = TextAnchor.MiddleCenter;
            hlg.childControlWidth   = true;
            hlg.childControlHeight  = true;
            hlg.childForceExpandWidth  = true;
            hlg.childForceExpandHeight = true;
            return go.transform;
        }
    }
}
