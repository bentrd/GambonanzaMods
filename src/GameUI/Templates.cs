using System.Collections.Generic;
using System.Reflection;
using TMPro;
using UnityEngine;

namespace Gambonanza.GameUI
{
    /// <summary>
    /// Lazily captures live game UI as inert template GameObjects, then caches them
    /// under a hidden DontDestroyOnLoad bucket. Each template is captured at most
    /// once per session.
    /// </summary>
    internal static class Templates
    {
        private const BindingFlags F = BindingFlags.NonPublic | BindingFlags.Instance;

        // ---- Button template -----------------------------------------------

        private static GameObject _buttonTemplate;
        private static List<int>  _buttonLabelPath;
        private static bool       _buttonAttempted;

        public static GameObject GetButtonTemplate(out List<int> labelPath)
        {
            labelPath = _buttonLabelPath;
            if (_buttonTemplate != null) return _buttonTemplate;
            if (_buttonAttempted) return null;     // tried, failed; don't spam
            _buttonAttempted = true;

            try { CaptureButton(); }
            catch (System.Exception ex) { Log.Line("button capture failed: " + ex); }

            labelPath = _buttonLabelPath;
            return _buttonTemplate;
        }

        private static void CaptureButton()
        {
            var canvasMenu = Hierarchy.FindByTypeFullName("Blukulele.CHE.CanvasMenu");
            if (canvasMenu == null) { Log.Line("CanvasMenu not in scene; button template unavailable."); return; }

            var t = canvasMenu.GetType();
            var settingsText = (t.GetField("m_Text_Settings", F)?.GetValue(canvasMenu)) as TMP_Text;
            var quitText     = (t.GetField("m_Text_Quit",     F)?.GetValue(canvasMenu)) as TMP_Text;
            if (settingsText == null || quitText == null)
            {
                Log.Line("CanvasMenu m_Text_Settings/m_Text_Quit missing; button template unavailable.");
                return;
            }

            var row = Hierarchy.FindCommonAncestor(new[] { settingsText.transform, quitText.transform });
            if (row == null) { Log.Line("Settings/Quit common ancestor not found."); return; }

            // Cell = direct child of `row` on the Settings path.
            Transform cell = settingsText.transform;
            while (cell != null && cell.parent != row) cell = cell.parent;
            if (cell == null) { Log.Line("Settings cell not found under row."); return; }

            var labelPath = Hierarchy.PathFromAncestor(cell, settingsText.transform);

            // Clone, strip, reset, deactivate.
            var clone = Object.Instantiate(cell.gameObject, Bucket.Root().transform);
            clone.name = "__GameUI_ButtonTemplate";
            clone.SetActive(false);

            // Keep the components that make a menu button feel like a menu button:
            // EventTrigger entries drive RotationButton (hover: scale 1.1 over 0.2s plus the
            // UI_MouseOver sound) and ShadowButton (the press). Stripping them - the old
            // behaviour - produced buttons with no hover and left callers to fake one with a
            // ColorTint, which is why injected buttons used to flash orange. Strip only the
            // selection plumbing that fights mod-driven buttons, then silence the persistent
            // listeners that point OUTSIDE the clone (the original menu action).
            int stripped = Strip.SelectionPlumbing(clone);
            int muted = Strip.MuteExternalListeners(clone);
            // Do NOT reset Image colors - the cloned cell has the designer's
            // cream tint baked in. A white tint would wash it out (the cell
            // sprite is white pixels tinted cream by Image.color).

            _buttonTemplate  = clone;
            _buttonLabelPath = labelPath;
            Log.Line($"captured button template (stripped {stripped}, muted {muted} external listener(s)).");
        }

        // ---- Modal template ------------------------------------------------

        private static GameObject _modalTemplate;
        private static List<int>  _modalTitlePath;
        private static List<int>  _modalContentPath;
        private static bool       _modalAttempted;

        public static GameObject GetModalTemplate(out List<int> titlePath, out List<int> contentPath)
        {
            titlePath   = _modalTitlePath;
            contentPath = _modalContentPath;
            if (_modalTemplate != null) return _modalTemplate;
            if (_modalAttempted) return null;
            _modalAttempted = true;

            try { CaptureModal(); }
            catch (System.Exception ex) { Log.Line("modal capture failed: " + ex); }

            titlePath   = _modalTitlePath;
            contentPath = _modalContentPath;
            return _modalTemplate;
        }

        private static void CaptureModal()
        {
            var settings = Hierarchy.FindByTypeFullName("Blukulele.CHE.SettingsCanvas");
            if (settings == null) { Log.Line("SettingsCanvas not in scene; modal template unavailable."); return; }

            var t = settings.GetType();
            var header       = (t.GetField("m_TextHeader",        F)?.GetValue(settings)) as TMP_Text;
            var gameplayCont = (t.GetField("m_GameplayContainer", F)?.GetValue(settings)) as GameObject;
            if (header == null || gameplayCont == null)
            {
                Log.Line("SettingsCanvas missing m_TextHeader/m_GameplayContainer.");
                return;
            }

            var rootT       = settings.transform;
            var titlePath   = Hierarchy.PathFromAncestor(rootT, header.transform);
            var contentPath = Hierarchy.PathFromAncestor(rootT, gameplayCont.transform);

            // Resolve every "destroy this in the clone" landmark to a path BEFORE cloning.
            // The set is discovered by shape (see SettingsTabs) so a tab the game adds
            // later - e.g. the 2026-05 "Customize" tab - is stripped without a code change.
            var destroyPaths = new List<List<int>>();
            void AddPath(Transform tr) { if (tr != null) destroyPaths.Add(Hierarchy.PathFromAncestor(rootT, tr)); }
            foreach (var tr in SettingsTabs.DiscardableTargets(settings)) AddPath(tr);

            // Clone the entire SettingsCanvas root under our bucket.
            var clone = Object.Instantiate(rootT.gameObject, Bucket.Root().transform);
            clone.name = "__GameUI_ModalTemplate";
            clone.SetActive(false);

            int stripped = Strip.Interactives(clone);

            // ---- KEY FIX: resolve ALL targets BEFORE destroying any of them.
            //               DestroyImmediate shifts sibling indices, so navigating
            //               by index after a destroy returns the wrong object.
            var resolved = new List<Transform>();
            foreach (var p in destroyPaths)
            {
                var tr = Hierarchy.NavigatePath(clone.transform, p);
                if (tr != null) resolved.Add(tr);
            }
            foreach (var tr in resolved)
                if (tr != null) Object.DestroyImmediate(tr.gameObject);

            // Empty the surviving content area; subsequent layout is the user's job.
            var contentT = Hierarchy.NavigatePath(clone.transform, contentPath);
            if (contentT == null)
            {
                Log.Line("Could not navigate to cloned content area.");
                Object.DestroyImmediate(clone);
                return;
            }
            for (int i = contentT.childCount - 1; i >= 0; i--)
                Object.DestroyImmediate(contentT.GetChild(i).gameObject);
            contentT.gameObject.SetActive(true);

            _modalTemplate    = clone;
            _modalTitlePath   = titlePath;
            _modalContentPath = contentPath;
            Log.Line($"captured modal template (stripped {stripped} comps, destroyed {resolved.Count} tab nodes).");
        }

        // ---- Arrow row template (Controls/Settings cell) -------------------

        private static GameObject _arrowRowTemplate;
        private static List<int>  _arrowTitlePath;
        private static List<int>  _arrowValuePath;
        private static List<int>  _arrowLeftPath;
        private static List<int>  _arrowRightPath;
        private static bool       _arrowAttempted;

        public static GameObject GetArrowRowTemplate(
            out List<int> titlePath, out List<int> valuePath,
            out List<int> leftPath,  out List<int> rightPath)
        {
            titlePath = _arrowTitlePath; valuePath = _arrowValuePath;
            leftPath  = _arrowLeftPath;  rightPath = _arrowRightPath;
            if (_arrowRowTemplate != null) return _arrowRowTemplate;
            if (_arrowAttempted) return null;
            _arrowAttempted = true;

            try { CaptureArrowRow(); }
            catch (System.Exception ex) { Log.Line("arrow-row capture failed: " + ex); }

            titlePath = _arrowTitlePath; valuePath = _arrowValuePath;
            leftPath  = _arrowLeftPath;  rightPath = _arrowRightPath;
            return _arrowRowTemplate;
        }

        private static void CaptureArrowRow()
        {
            var settings = Hierarchy.FindByTypeFullName("Blukulele.CHE.SettingsCanvas");
            if (settings == null) { Log.Line("SettingsCanvas missing; arrow-row template unavailable."); return; }

            var t = settings.GetType();
            var titleText = (t.GetField("m_ControlsTitle",   F)?.GetValue(settings)) as TMP_Text;
            var valueText = (t.GetField("m_CurrentControls", F)?.GetValue(settings)) as TMP_Text;
            if (titleText == null || valueText == null)
            {
                Log.Line("SettingsCanvas m_ControlsTitle/m_CurrentControls missing.");
                return;
            }

            // Inner cell = common ancestor of title + value (then up one if it's a leaf).
            Transform innerCell = Hierarchy.FindCommonAncestor(new[] { titleText.transform, valueText.transform });
            if (innerCell == null || innerCell.parent == null) { Log.Line("Could not derive controls cell."); return; }
            if (innerCell == titleText.transform || innerCell == valueText.transform) innerCell = innerCell.parent;

            // Wrapper = the layout-participating parent we actually want to clone.
            Transform wrapper = innerCell.parent;
            if (wrapper == null) { Log.Line("Controls wrapper missing."); return; }

            var leftArrow  = Hierarchy.FindChildByName(innerCell, "Left_Arrow");
            var rightArrow = Hierarchy.FindChildByName(innerCell, "Right_Arrow");
            if (leftArrow == null || rightArrow == null) { Log.Line("Left_Arrow/Right_Arrow missing under controls cell."); return; }

            var titlePath = Hierarchy.PathFromAncestor(wrapper, titleText.transform);
            var valuePath = Hierarchy.PathFromAncestor(wrapper, valueText.transform);
            var leftPath  = Hierarchy.PathFromAncestor(wrapper, leftArrow);
            var rightPath = Hierarchy.PathFromAncestor(wrapper, rightArrow);

            var clone = Object.Instantiate(wrapper.gameObject, Bucket.Root().transform);
            clone.name = "__GameUI_ArrowRowTemplate";
            clone.SetActive(false);

            int stripped = Strip.Interactives(clone);
            Strip.ResetImageColors(clone);

            _arrowRowTemplate = clone;
            _arrowTitlePath   = titlePath;
            _arrowValuePath   = valuePath;
            _arrowLeftPath    = leftPath;
            _arrowRightPath   = rightPath;
            Log.Line($"captured arrow-row template (stripped {stripped} comps).");
        }

        // ---- Checkbox sprites (Settings menu toggle) -----------------------

        // We don't clone a Toggle GameObject anymore. The Settings toggles in
        // this game are wide pills with the checkmark anchored stretch inside,
        // so a clone reproduces a stretched checkmark whatever fixed size we
        // give the cell. Instead we capture just the SPRITES + colours and
        // rebuild the widget at a known square size in Pixel.CreateCheckbox.
        private static Sprite _checkboxBoxSprite;
        private static Color  _checkboxBoxColor  = new Color(0.92f, 0.86f, 0.66f, 1f);
        private static Sprite _checkmarkSprite;
        private static Color  _checkmarkColor    = new Color(0.36f, 0.13f, 0.11f, 1f);
        private static bool   _checkboxCaptured;
        private static bool   _checkboxAttempted;

        /// <summary>
        /// Returns the captured Settings-menu checkbox visual (the small cream
        /// box with the dark checkmark child). <paramref name="checkPath"/> walks
        /// the clone tree to the checkmark GameObject; toggle it active to show
        /// "checked", inactive to show "unchecked". <paramref name="boxSize"/> is
        /// the captured pixel size - callers MUST pin this via a LayoutElement
        /// so outer layout groups don't stretch the box (which makes the
        /// checkmark fill the cell as a giant dark rectangle).
        /// </summary>
        /// <summary>
        /// Returns the cream box sprite + dark checkmark sprite scraped from a
        /// live Settings-menu Toggle. Out params always carry sensible defaults
        /// (cream / dark warm) so callers can build a passable checkbox even if
        /// capture fails. Returns true when both sprites were captured from the
        /// game; false on the default-only path.
        /// </summary>
        public static bool TryGetCheckboxSprites(
            out Sprite boxSprite, out Color boxColor,
            out Sprite checkSprite, out Color checkColor)
        {
            if (!_checkboxCaptured && !_checkboxAttempted)
            {
                _checkboxAttempted = true;
                try { CaptureCheckbox(); }
                catch (System.Exception ex) { Log.Line("checkbox capture failed: " + ex); }
            }
            boxSprite   = _checkboxBoxSprite;
            boxColor    = _checkboxBoxColor;
            checkSprite = _checkmarkSprite;
            checkColor  = _checkmarkColor;
            return _checkboxCaptured;
        }

        private static void CaptureCheckbox()
        {
            var settings = Hierarchy.FindByTypeFullName("Blukulele.CHE.SettingsCanvas");
            if (settings == null) { Log.Line("checkbox: SettingsCanvas missing."); return; }

            // Any UnityEngine.UI.Toggle inside Settings will do. Include inactive
            // results - Graphics-tab toggles are inactive when the panel first
            // opens.
            var toggles = settings.GetComponentsInChildren<UnityEngine.UI.Toggle>(true);
            if (toggles == null || toggles.Length == 0) { Log.Line("checkbox: no Toggle in SettingsCanvas."); return; }

            foreach (var toggle in toggles)
            {
                if (toggle == null) continue;
                var bg = toggle.targetGraphic as UnityEngine.UI.Image;
                var ck = toggle.graphic       as UnityEngine.UI.Image;
                if (bg == null || ck == null) continue;
                if (bg.sprite == null || ck.sprite == null) continue;

                _checkboxBoxSprite = bg.sprite;
                _checkboxBoxColor  = bg.color;
                _checkmarkSprite   = ck.sprite;
                _checkmarkColor    = ck.color;
                _checkboxCaptured  = true;
                Log.Line($"captured checkbox sprites: box={bg.sprite.name} ({bg.color}), check={ck.sprite.name} ({ck.color}).");
                return;
            }
            Log.Line("checkbox: no Toggle with Image targetGraphic + Image graphic with sprites.");
        }

        // ---- Diagnostic ----------------------------------------------------

        private static void DumpHierarchy(Transform root, int depth, int maxDepth, string tag)
        {
            if (root == null || depth > maxDepth) return;
            var rt = root as RectTransform;
            string size = rt != null ? $"  rect=({rt.rect.width:0}x{rt.rect.height:0})" : "";
            string canvas = root.GetComponent<UnityEngine.Canvas>() != null ? "  [Canvas]" : "";
            string cg = root.GetComponent<UnityEngine.CanvasGroup>() != null ? "  [CanvasGroup]" : "";
            string act = root.gameObject.activeSelf ? "+" : "-";
            Log.Line($"  [{tag}] {new string(' ', depth * 2)}{act} {root.name}{size}{canvas}{cg}");
            for (int i = 0; i < root.childCount; i++)
                DumpHierarchy(root.GetChild(i), depth + 1, maxDepth, tag);
        }

        // ---- Misc ----------------------------------------------------------

        private static TMP_FontAsset _bestFont;

        public static TMP_FontAsset BestFont()
        {
            if (_bestFont != null) return _bestFont;
            var all = Resources.FindObjectsOfTypeAll<TMP_FontAsset>();
            for (int i = 0; i < all.Length; i++)
            {
                var f = all[i];
                if (f == null) continue;
                var n = f.name ?? "";
                if (n.Contains("Fallback") || n.Contains("LiberationSans")) continue;
                _bestFont = f;
                return _bestFont;
            }
            _bestFont = all.Length > 0 ? all[0] : null;
            return _bestFont;
        }
    }
}
