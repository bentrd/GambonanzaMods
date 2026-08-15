using System;
using System.IO;
using UnityEngine;

namespace Gambonanza.BetterCollection
{
    /// <summary>
    /// Tunables, read from config.json next to the DLL. Written back out on first
    /// run so the knobs are discoverable without reading the source.
    /// </summary>
    [Serializable]
    public sealed class BetterCollectionConfig
    {
        /// <summary>
        /// How many stacked UI Outline components to keep per graphic, per colour.
        /// Vanilla stacks up to four, and they compose multiplicatively (x5 each),
        /// so the page arrows end up at x1250.
        ///
        /// 2 is the default: the arrows drop from x1250 to x25 (a 6-vertex quad stops
        /// rebuilding as 7,500 vertices) while two stacked outlines still read as a
        /// solid line. 1 is thinner and cheaper still; 3 keeps more thickness for less
        /// gain; 4 is a no-op, since the deepest chain in the game is exactly 4 - it
        /// collapses nothing and gives you vanilla performance.
        ///
        /// Pair 2 with compensateThickness to match vanilla thickness exactly.
        /// </summary>
        public int maxOutlines = 2;

        /// <summary>
        /// Widen the surviving outlines to span the original stack's thickness.
        /// Off by default because it is only safe above maxOutlines = 1: a single
        /// Outline emits four *diagonal* copies, so a large distance reads as ghosting
        /// rather than a thicker line. At the default of 2 it is a good pairing -
        /// turn it on to match vanilla thickness exactly.
        /// </summary>
        public bool compensateThickness = false;

        /// <summary>
        /// Also treat the run-info screen (opened mid-run). It embeds the same
        /// Gambit_Slide prefab, arrows and all, so it has the identical problem -
        /// and it is on screen during actual gameplay.
        /// </summary>
        public bool alsoRunInfoScreen = true;

        /// <summary>Type-to-filter search bar on the collection screen.</summary>
        public bool enableSearch = true;

        public static BetterCollectionConfig Load(string modDirectory, Action<string> log)
        {
            var cfg = new BetterCollectionConfig();
            if (string.IsNullOrEmpty(modDirectory)) return cfg;

            string path = Path.Combine(modDirectory, "config.json");
            try
            {
                if (File.Exists(path))
                {
                    JsonUtility.FromJsonOverwrite(File.ReadAllText(path), cfg);
                }
                else
                {
                    File.WriteAllText(path, JsonUtility.ToJson(cfg, true));
                    log?.Invoke("wrote default config.json");
                }
            }
            catch (Exception ex)
            {
                log?.Invoke("config.json unreadable, using defaults: " + ex.Message);
            }

            if (cfg.maxOutlines < 0) cfg.maxOutlines = 0;
            if (cfg.maxOutlines > 4) cfg.maxOutlines = 4;
            return cfg;
        }

        public void Save(string modDirectory, Action<string> log)
        {
            if (string.IsNullOrEmpty(modDirectory)) return;
            try
            {
                File.WriteAllText(Path.Combine(modDirectory, "config.json"), JsonUtility.ToJson(this, true));
            }
            catch (Exception ex)
            {
                log?.Invoke("could not save config.json: " + ex.Message);
            }
        }
    }
}
