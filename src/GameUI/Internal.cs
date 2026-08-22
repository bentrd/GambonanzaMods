using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using TMPro;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace Gambonanza.GameUI
{
    internal static class Log
    {
        public static void Line(string s)
        {
            try { Debug.Log("[GameUI] " + s); } catch { }
        }
    }

    internal static class Strip
    {
        /// <summary>
        /// Remove every component on <paramref name="root"/> (and children) that would
        /// route input back into the original game object: anything in the Blukulele
        /// namespace, Selectable subclasses, EventTriggers, and custom MonoBehaviours
        /// whose type name hints at button/feedback/rewired wiring. Returns the count.
        /// </summary>
        /// <summary>
        /// For cloned buttons that should KEEP their native hover/press: removes only the
        /// selection plumbing (Selectable, Rewired, gamepad select feedback), leaving
        /// EventTrigger + the game's hover/press MonoBehaviours in place.
        /// </summary>
        public static int SelectionPlumbing(GameObject root)
        {
            if (root == null) return 0;
            int n = 0;
            foreach (var s in root.GetComponentsInChildren<Selectable>(true).ToArray())
            { if (s != null) { UnityEngine.Object.DestroyImmediate(s); n++; } }
            foreach (var mb in root.GetComponentsInChildren<MonoBehaviour>(true).ToArray())
            {
                if (mb == null) continue;
                var typeName = mb.GetType().Name;
                if (typeName.Contains("Rewired") || typeName == "SelectFeedback")
                { UnityEngine.Object.DestroyImmediate(mb); n++; }
            }
            return n;
        }

        /// <summary>
        /// Silences EventTrigger persistent listeners whose target lives outside `root` -
        /// i.e. the original menu action on a cloned button - while keeping listeners that
        /// drive the clone's own hover/press components. Without this, a cloned Settings
        /// button still opens Settings; with the old full strip, it did nothing at all.
        /// </summary>
        public static int MuteExternalListeners(GameObject root)
        {
            if (root == null) return 0;
            int n = 0;
            foreach (var trigger in root.GetComponentsInChildren<EventTrigger>(true))
            {
                if (trigger.triggers == null) continue;
                foreach (var entry in trigger.triggers)
                {
                    if (entry == null || entry.callback == null) continue;
                    for (int i = 0; i < entry.callback.GetPersistentEventCount(); i++)
                    {
                        var target = entry.callback.GetPersistentTarget(i) as Component;
                        bool inside = target != null && target.transform.IsChildOf(root.transform);
                        if (!inside)
                        {
                            entry.callback.SetPersistentListenerState(i, UnityEngine.Events.UnityEventCallState.Off);
                            n++;
                        }
                    }
                }
            }
            return n;
        }

        public static int Interactives(GameObject root)
        {
            if (root == null) return 0;
            int n = 0;
            foreach (var s in root.GetComponentsInChildren<Selectable>(true).ToArray())
            { if (s != null) { UnityEngine.Object.DestroyImmediate(s); n++; } }

            foreach (var et in root.GetComponentsInChildren<EventTrigger>(true).ToArray())
            { if (et != null) { UnityEngine.Object.DestroyImmediate(et); n++; } }

            foreach (var mb in root.GetComponentsInChildren<MonoBehaviour>(true).ToArray())
            {
                if (mb == null) continue;
                var fullName = mb.GetType().FullName ?? "";
                var typeName = mb.GetType().Name;
                if (fullName.StartsWith("Blukulele")
                    || typeName.Contains("Button")
                    || typeName.Contains("Feedback")
                    || typeName.Contains("Selectable")
                    || typeName.Contains("Rewired"))
                {
                    UnityEngine.Object.DestroyImmediate(mb);
                    n++;
                }
            }
            return n;
        }

        /// <summary>
        /// Reset every Image's color to white (and enable raycastTarget). The
        /// ColorTint transition on the original Selectable left whatever tint was
        /// last applied - usually a faded "normal" - so without this clones look
        /// disabled even though they're interactive.
        /// </summary>
        public static void ResetImageColors(GameObject root)
        {
            if (root == null) return;
            foreach (var img in root.GetComponentsInChildren<Image>(true))
            {
                if (img == null) continue;
                img.color = Color.white;
                img.raycastTarget = true;
            }
        }
    }

    internal static class ButtonStyle
    {
        public static void ApplyDefaultColors(Button btn)
        {
            if (btn == null) return;
            btn.transition = Selectable.Transition.ColorTint;
            var c = btn.colors;
            c.normalColor      = Color.white;
            c.highlightedColor = new Color(1f,    0.78f, 0.55f, 1f);
            c.pressedColor     = new Color(0.65f, 0.45f, 0.30f, 1f);
            c.selectedColor    = new Color(1f,    0.85f, 0.65f, 1f);
            c.disabledColor    = new Color(0.5f,  0.5f,  0.5f,  0.5f);
            c.colorMultiplier  = 1f;
            c.fadeDuration     = 0.08f;
            btn.colors = c;
        }
    }

    /// <summary>
    /// Discovers the tab containers and tab buttons on a live
    /// <c>Blukulele.CHE.SettingsCanvas</c> by reflection rather than by name.
    ///
    /// Every mod modal is built by cloning the Settings panel and deleting the tabs
    /// we don't want. Hard-coding that delete list (Graphics / Audio / Twitch) meant
    /// each new vanilla tab leaked into every mod's modal: the 2026-05 update shipped
    /// a "Customize" tab (m_Customize / m_CustomizeContainer) and its board-skin
    /// picker showed up inside the Mods window. Matching on the m_*Container /
    /// m_*Button shape instead means the next tab the game adds is handled for free.
    /// </summary>
    internal static class SettingsTabs
    {
        private const BindingFlags F = BindingFlags.NonPublic | BindingFlags.Instance;

        /// <summary>The tab we keep - its container is the modal's content area.</summary>
        public const string KeptContainerField = "m_GameplayContainer";
        public const string KeptButtonField    = "m_GameplayButton";

        /// <summary>
        /// Every tab container / tab button transform on <paramref name="settings"/>
        /// except the kept (Gameplay) pair. These are the nodes to delete from a clone.
        /// </summary>
        public static List<Transform> DiscardableTargets(MonoBehaviour settings)
        {
            var found = new List<Transform>();
            if (settings == null) return found;

            foreach (var f in settings.GetType().GetFields(F))
            {
                bool isContainer = f.Name.EndsWith("Container", StringComparison.Ordinal)
                                && f.Name != KeptContainerField;
                // Tab buttons are matched by TYPE, not name suffix: the game names some
                // of them without the "Button" suffix (m_Customize since 2026-05,
                // m_Accessibility since build 24613134) and every ButtonSettings field
                // on SettingsCanvas is a tab button, so the type is the reliable shape.
                bool isTabButton = (f.Name.EndsWith("Button", StringComparison.Ordinal)
                                    || f.FieldType.Name == "ButtonSettings")
                                && f.Name != KeptButtonField;
                if (!isContainer && !isTabButton) continue;

                object val;
                try { val = f.GetValue(settings); } catch { continue; }
                if (val == null) continue;

                Transform target = null;
                if (val is GameObject go)     target = go.transform;
                else if (val is Component co) target = co.transform;   // covers MonoBehaviour
                if (target != null) found.Add(target);
            }
            return found;
        }
    }

    internal static class Bucket
    {
        private static GameObject _root;

        /// <summary>
        /// Hidden DontDestroyOnLoad container that holds inert template clones.
        /// Created on demand. Templates parented under here survive scene loads
        /// and don't show up in the active scene.
        /// </summary>
        public static GameObject Root()
        {
            if (_root != null) return _root;
            _root = new GameObject("__GameUI_TemplateBucket");
            _root.SetActive(false);
            UnityEngine.Object.DontDestroyOnLoad(_root);
            _root.hideFlags = HideFlags.HideAndDontSave;
            return _root;
        }
    }

    internal static class Safe
    {
        public static void Invoke(Action a)
        {
            if (a == null) return;
            try { a(); } catch (Exception ex) { Log.Line("callback threw: " + ex); }
        }
    }
}
