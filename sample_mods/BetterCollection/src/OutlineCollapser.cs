using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace Gambonanza.BetterCollection
{
    /// <summary>
    /// Collapses stacked UI mesh effects on a UI subtree.
    ///
    /// Why this is the whole mod: <c>Outline.ModifyMesh</c> appends four copies of the
    /// entire accumulated vertex stream (x5), and <c>Shadow</c> appends one (x2). Because
    /// each effect re-reads what the previous one produced, stacking composes
    /// *multiplicatively*. The collection screen ships graphics with four stacked
    /// Outlines plus a Shadow - x1250 - so a 6-vertex quad rebuilds as 7,500 vertices,
    /// and every rebuild pushes that through List&lt;UIVertex&gt; copies.
    ///
    /// Keeping one Outline per colour keeps the art direction and removes almost all
    /// of the geometry. Everything is recorded so <see cref="Revert"/> restores the
    /// screen exactly, which is what lets the mod be toggled off in-game.
    /// </summary>
    public sealed class OutlineCollapser
    {
        private struct Entry
        {
            public Shadow Effect;
            public bool WasEnabled;
            public Vector2 OriginalDistance;
        }

        private readonly List<Entry> _touched = new List<Entry>();
        private readonly HashSet<Graphic> _processed = new HashSet<Graphic>();

        public int ChainsCollapsed { get; private set; }
        public int EffectsDisabled { get; private set; }
        public int VertsBefore { get; private set; }
        public int VertsAfter { get; private set; }

        /// <summary>
        /// Vertices an Image-like graphic emits after its enabled effect chain runs.
        /// 6 = two triangles; effects operate on the triangle stream, not the quad.
        /// </summary>
        public static int VertsFor(Graphic g)
        {
            if (!(g is Image) && !(g is RawImage)) return 0;
            int mult = 1;
            foreach (var e in g.GetComponents<Shadow>())
            {
                if (e == null || !e.enabled) continue;
                mult *= (e is Outline) ? 5 : 2;
            }
            return 6 * mult;
        }

        public static int CountVerts(GameObject root)
        {
            int total = 0;
            foreach (var g in root.GetComponentsInChildren<Graphic>(true)) total += VertsFor(g);
            return total;
        }

        /// <summary>
        /// Idempotent: graphics already collapsed are skipped, so this can be re-run
        /// whenever the screen opens without compounding.
        /// </summary>
        public void Apply(GameObject root, int maxOutlines, bool compensateThickness)
        {
            if (root == null) return;

            foreach (var graphic in root.GetComponentsInChildren<Graphic>(true))
            {
                if (graphic == null || _processed.Contains(graphic)) continue;
                _processed.Add(graphic);

                var effects = graphic.GetComponents<Shadow>();
                if (effects == null || effects.Length == 0) continue;

                VertsBefore += VertsFor(graphic);

                // Outline and plain Shadow are visually different roles, and Outline
                // derives from Shadow, so they have to be bucketed separately.
                CollapseGroup(effects, wantOutline: true, keep: maxOutlines, compensateThickness);
                CollapseGroup(effects, wantOutline: false, keep: 1, compensateThickness);

                VertsAfter += VertsFor(graphic);
            }
        }

        /// <summary>
        /// Collapses same-coloured effects of one kind down to <paramref name="keep"/>.
        /// Grouping by colour matters: a chain can be a light inner line plus a dark
        /// outer one, and merging those would silently change the art.
        /// </summary>
        private void CollapseGroup(Shadow[] effects, bool wantOutline, int keep, bool compensateThickness)
        {
            var byColour = new Dictionary<uint, List<Shadow>>();
            foreach (var e in effects)
            {
                if (e == null || !e.enabled) continue;
                if ((e is Outline) != wantOutline) continue;
                uint key = ColourKey(e.effectColor);
                if (!byColour.TryGetValue(key, out var list)) byColour[key] = list = new List<Shadow>();
                list.Add(e);
            }

            foreach (var kv in byColour)
            {
                var group = kv.Value;
                if (group.Count <= keep) continue; // nothing stacked here to remove

                ChainsCollapsed++;

                // Thinnest distance in the group: a single Outline emits only four
                // diagonal copies, so a large distance shows as ghosting instead of a
                // thicker line. The smallest one always reads as a clean outline.
                Vector2 thinnest = group[0].effectDistance;
                Vector2 sum = Vector2.zero;
                foreach (var e in group)
                {
                    sum += new Vector2(Mathf.Abs(e.effectDistance.x), Mathf.Abs(e.effectDistance.y));
                    if (e.effectDistance.sqrMagnitude < thinnest.sqrMagnitude) thinnest = e.effectDistance;
                }

                for (int i = 0; i < group.Count; i++)
                {
                    var e = group[i];
                    Record(e);
                    if (i < keep)
                    {
                        if (compensateThickness)
                        {
                            // Spread the original stack's total thickness across the
                            // survivors: k outlines at sum/k span the same distance.
                            // Signs come from the original so the offset direction holds.
                            Vector2 d = sum / keep;
                            Vector2 origin = group[0].effectDistance;
                            e.effectDistance = new Vector2(
                                origin.x < 0f ? -d.x : d.x,
                                origin.y < 0f ? -d.y : d.y);
                        }
                        else
                        {
                            e.effectDistance = thinnest;
                        }
                    }
                    else
                    {
                        // BaseMeshEffect.OnDisable calls SetVerticesDirty, so the mesh
                        // regenerates without this pass immediately.
                        e.enabled = false;
                        EffectsDisabled++;
                    }
                }
            }
        }

        private static uint ColourKey(Color c)
        {
            Color32 c32 = c;
            return (uint)(c32.r << 24 | c32.g << 16 | c32.b << 8 | c32.a);
        }

        private void Record(Shadow e)
        {
            _touched.Add(new Entry { Effect = e, WasEnabled = e.enabled, OriginalDistance = e.effectDistance });
        }

        public void Revert()
        {
            for (int i = _touched.Count - 1; i >= 0; i--)
            {
                var t = _touched[i];
                if (t.Effect == null) continue;
                t.Effect.effectDistance = t.OriginalDistance;
                t.Effect.enabled = t.WasEnabled;
            }
            _touched.Clear();
            _processed.Clear();
            ChainsCollapsed = EffectsDisabled = VertsBefore = VertsAfter = 0;
        }
    }
}
