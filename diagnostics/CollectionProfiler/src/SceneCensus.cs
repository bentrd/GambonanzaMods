using System.Collections.Generic;
using System.Text;
using UnityEngine;
using UnityEngine.UI;

namespace Gambonanza.CollectionProfiler
{
    /// <summary>
    /// One-time census of the live collection canvas. This exists to confirm at
    /// runtime what was measured statically from the scene file - if these numbers
    /// disagree with the report's premises, the report's ranking is suspect.
    /// </summary>
    public static class SceneCensus
    {
        public static string Describe(GameObject root)
        {
            var sb = new StringBuilder();
            var counts = new Dictionary<string, int>();

            foreach (var c in root.GetComponentsInChildren<Component>(true))
            {
                if (c == null) continue;
                string n = c.GetType().Name;
                counts.TryGetValue(n, out int v);
                counts[n] = v + 1;
            }

            sb.AppendLine("## Live scene census (CNV_Collection)");
            sb.AppendLine();
            sb.AppendLine("| component | count |");
            sb.AppendLine("|---|---|");
            foreach (var key in new[]
            {
                "CanvasRenderer", "Canvas", "GraphicRaycaster", "Image", "TextMeshProUGUI",
                "Outline", "Shadow", "OutlineFilter", "AutoLayoutRebuilder",
                "ContentSizeFitter", "HorizontalLayoutGroup", "VerticalLayoutGroup",
                "GridLayoutGroup", "Mask", "TextAnimator_TMP", "GambitLibraryIconBehaviour",
            })
            {
                counts.TryGetValue(key, out int v);
                sb.AppendLine($"| {key} | {v} |");
            }

            // Renderers sharing the root canvas batch: reachable without crossing a
            // nested Canvas. This is what gets rebatched when any one element dirties.
            int rootBatch = CountRootBatch(root.transform, true);
            sb.AppendLine();
            sb.AppendLine($"- CanvasRenderers in the single root canvas batch: **{rootBatch}**");

            // Vertex amplification from stacked BaseMeshEffects.
            int baseVerts = 0, ampVerts = 0, worstMult = 1;
            string worstName = "-";
            foreach (var g in root.GetComponentsInChildren<Graphic>(true))
            {
                if (g == null) continue;
                int quadVerts = (g is Image || g is RawImage) ? 6 : 0; // triangle stream, 2 tris
                if (quadVerts == 0) continue;
                int mult = 1;
                foreach (var comp in g.GetComponents<Shadow>())
                {
                    if (comp == null || !comp.enabled) continue;
                    mult *= (comp is Outline) ? 5 : 2;
                }
                baseVerts += quadVerts;
                ampVerts += quadVerts * mult;
                if (mult > worstMult) { worstMult = mult; worstName = g.name; }
            }
            sb.AppendLine($"- Image verts: {baseVerts} base -> **{ampVerts}** after Outline/Shadow stacking");
            sb.AppendLine($"- worst single graphic: **{worstName} x{worstMult}**");
            sb.AppendLine();
            return sb.ToString();
        }

        private static int CountRootBatch(Transform t, bool isRoot)
        {
            if (!isRoot && t.GetComponent<Canvas>() != null) return 0; // its own batch
            int n = t.GetComponent<CanvasRenderer>() != null ? 1 : 0;
            for (int i = 0; i < t.childCount; i++) n += CountRootBatch(t.GetChild(i), false);
            return n;
        }
    }
}
