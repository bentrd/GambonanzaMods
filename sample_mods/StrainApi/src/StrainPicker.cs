using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using Blukulele.CHE;
using Gambonanza.GameUI;
using UnityEngine;
using UnityEngine.UI;

namespace Gambonanza.StrainApi
{
    /// <summary>
    /// The player's way to pick modded strains: a MOD STRAINS button on the home screen
    /// (next to Settings) opening a modal with one ON/OFF toggle per registered strain.
    /// Built entirely from Gambonanza.GameUI, so it wears the game's own buttons and
    /// panel. Picks apply to the next run, exactly like the game's strain screen.
    /// </summary>
    internal static class StrainPicker
    {
        private const string HomeButtonName = "StrainApi_HomeMenuButton";
        private const string ModalName = "StrainApi_Picker";
        private const int PageSize = 4;

        private static readonly Regex Markup = new Regex("<[^>]*>", RegexOptions.CultureInvariant);

        private static Modal _modal;
        private static Button _prev;
        private static Button _next;
        private static int _page;
        private static readonly List<KeyValuePair<string, PixelToggle>> _toggles = new List<KeyValuePair<string, PixelToggle>>();

        private static Button _homeButton;
        private static CanvasMenu _failedMenu;      // the menu the button could not be added to; not retried

        /// <summary>Plain text for places that do not run the game's text markup.</summary>
        internal static string PlainText(string text)
            => string.IsNullOrEmpty(text) ? "" : Markup.Replace(text, "").Replace("  ", " ").Trim();

        /// <summary>
        /// Called while the game is in MENU: add the home-screen button once there is
        /// something to pick. Cheap when the button is already there.
        /// </summary>
        internal static void EnsureHomeButton()
        {
            if (_homeButton || StrainRegistry.Count == 0) return;
            var menu = UnityEngine.Object.FindAnyObjectByType<CanvasMenu>();
            if (!menu || menu == _failedMenu) return;
            try
            {
                var existing = Hierarchy.FindChildByName(menu.transform, HomeButtonName);
                _homeButton = existing != null
                    ? existing.GetComponent<Button>()
                    : Pixel.AddHomeMenuButton(menu, "Mod Strains", HomeButtonName, Open);
                if (_homeButton) StrainCore.Log("MOD STRAINS button is on the home screen.");
                else
                {
                    _failedMenu = menu;
                    StrainCore.Log("could not add the MOD STRAINS button (see the [GameUI] log); 'strain picker' in the console opens the picker.");
                }
            }
            catch (Exception ex)
            {
                _failedMenu = menu;
                StrainCore.Log("could not add the MOD STRAINS button ('strain picker' opens the picker): " + ex.Message);
            }
        }

        internal static void Open()
        {
            try
            {
                if (_modal == null || !_modal.Root) Build();
                if (_modal == null) return;
                _page = 0;
                Populate();
                _modal.Show();
            }
            catch (Exception ex) { StrainCore.Log("could not open the strain picker: " + ex); }
        }

        /// <summary>Remove the button and the modal (StrainApi disabled).</summary>
        internal static void Teardown()
        {
            if (_homeButton) UnityEngine.Object.Destroy(_homeButton.gameObject);
            if (_modal != null && _modal.Root) UnityEngine.Object.Destroy(_modal.Root);
            _homeButton = null;
            _failedMenu = null;
            _modal = null;
            _prev = _next = null;
            _toggles.Clear();
        }

        private static void Build()
        {
            _modal = Pixel.CreateModal(ModalName, "MOD STRAINS");
            if (_modal == null || !_modal.Root) { _modal = null; StrainCore.Log("GameUI could not build the picker."); return; }
            _prev = _modal.AddToolbarButton("< PREV", () => Turn(-1));
            _next = _modal.AddToolbarButton("NEXT >", () => Turn(+1));
            _modal.AddToolbarButton("ALL OFF", () => { StrainCore.ClearSelection(); Refresh(); });
            _modal.AddToolbarButton("CLOSE", _modal.Hide);
        }

        private static int PageCount => Math.Max(1, (StrainRegistry.Count + PageSize - 1) / PageSize);

        private static void Turn(int delta)
        {
            _page = Mathf.Clamp(_page + delta, 0, PageCount - 1);
            Populate();
        }

        private static void Populate()
        {
            var content = _modal.Content;
            for (int i = content.childCount - 1; i >= 0; i--)
            {
                // Detach first: Destroy lands at the end of the frame and the layout
                // group would still count the old rows until then.
                var child = content.GetChild(i);
                child.SetParent(null, false);
                UnityEngine.Object.Destroy(child.gameObject);
            }
            _toggles.Clear();

            var all = StrainRegistry.All;
            if (all.Count == 0) AddText(content, "No mod has registered a strain.", 22, 40f);

            _page = Mathf.Clamp(_page, 0, PageCount - 1);
            for (int i = _page * PageSize; i < Math.Min(all.Count, (_page + 1) * PageSize); i++)
            {
                var def = all[i];
                var id = def.Id;
                var toggle = Pixel.CreateToggle(content, def.Name, StrainCore.IsSelected(id), on =>
                {
                    var current = StrainRegistry.Get(id);
                    if (current != null) StrainCore.SetSelected(current, on);
                    Refresh();
                });
                if (toggle?.Root != null) _toggles.Add(new KeyValuePair<string, PixelToggle>(id, toggle));
                AddText(content, PlainText(def.Description), 18, 48f);
            }

            if (_prev) _prev.gameObject.SetActive(PageCount > 1);
            if (_next) _next.gameObject.SetActive(PageCount > 1);
            Refresh();
        }

        /// <summary>Re-read every toggle (a pick may have deselected an incompatible one) and the status line.</summary>
        private static void Refresh()
        {
            foreach (var pair in _toggles)
                pair.Value.Set(StrainCore.IsSelected(pair.Key), notify: false);

            if (_modal?.Status == null) return;
            var picked = Strains.Selected.Count;
            var page = PageCount > 1 ? $"Page {_page + 1}/{PageCount}. " : "";
            var run = StrainCore.InRun ? " The run in progress keeps its own." : "";
            _modal.Status.text = $"{page}{picked} picked - they apply from your next run.{run}";
        }

        private static void AddText(Transform parent, string text, float size, float height)
        {
            var label = Pixel.CreateLabel(parent, text, size);
            if (label == null) return;
            var element = label.gameObject.AddComponent<LayoutElement>();
            element.preferredHeight = height;
            element.minHeight = height;
        }
    }
}
