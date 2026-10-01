using System;
using System.Collections.Generic;
using Unity.Collections;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.U2D;

namespace Gambonanza.ModHost
{
    /// <summary>
    /// Re-cut sprites: let a pack say "this sprite is THAT rectangle of its sheet
    /// now", so art painted outside the original cut shows up in the game.
    ///
    /// A sprite is a named rectangle on a sheet plus a small mesh that draws it.
    /// Replacing the sheet changes the pixels and nothing else, so anything painted
    /// past the original rectangle is simply never sampled - a 40x19 mouth drawn
    /// over a 20x4 one shows as a 20x4 slice of itself.
    ///
    /// The rectangle is read-only on a Sprite, and Sprite.OverrideGeometry refuses
    /// vertices outside it. Making a NEW sprite with Sprite.Create would work for
    /// one renderer and then lose to the game: prefabs, serialized fields and
    /// animation clips all still hold the original and assign it straight back.
    ///
    /// So the original is edited in place. SpriteDataAccessExtensions writes the
    /// sprite's vertex buffer directly, with no rectangle check, and every
    /// SpriteRenderer that shares the sprite draws the new quad without being
    /// touched. The quad is placed so the original pixels stay exactly where they
    /// were on screen - the cut grows around them.
    ///
    /// It only reaches sprites the game draws with a SpriteRenderer. A UI Image
    /// builds its own quad from the sprite's rectangle and its RectTransform and
    /// never looks at the mesh, so it is unaffected.
    /// </summary>
    internal static class ResourcePackSprites
    {
        internal class Frame
        {
            /// <summary>Unity object name of the sprite, e.g. "ComputerBoss_Mouth".</summary>
            public string Name;
            /// <summary>Unity object name of the sheet it sits on. Sprite names repeat
            /// across sheets, so the name alone does not identify one.</summary>
            public string Texture;
            /// <summary>The new cut, in sheet pixels from the BOTTOM left - Unity's
            /// convention, and the one the asset catalogue uses.</summary>
            public int X, Y, W, H;
            public bool Applied;
            public string Key => Texture + "/" + Name;
        }

        private static readonly List<Frame> Frames = new List<Frame>();
        private static readonly Dictionary<string, List<Frame>> ByName = new Dictionary<string, List<Frame>>(StringComparer.Ordinal);

        /// <summary>Instance ids already dealt with, re-cut or refused.</summary>
        private static readonly HashSet<int> Done = new HashSet<int>();

        /// <summary>The edit lives on the loaded asset, so an unload would quietly
        /// bring the vanilla cut back. Hold what was changed.</summary>
        private static readonly List<Sprite> Pinned = new List<Sprite>();

        public static int Count => Frames.Count;
        public static int AppliedCount { get { int n = 0; foreach (var f in Frames) if (f.Applied) n++; return n; } }
        public static IEnumerable<Frame> All => Frames;

        internal static void Load(Dictionary<string, object> root, Action<string> problem)
        {
            foreach (var raw in TinyJson.Array(root, "sprites"))
            {
                var item = TinyJson.AsObject(raw);
                if (item == null) continue;
                var name = TinyJson.Str(item, "name");
                var texture = TinyJson.Str(item, "texture");
                var rect = TinyJson.Array(item, "rect");
                if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(texture)) continue;
                if (rect.Count != 4 || !(rect[0] is double) || !(rect[1] is double) || !(rect[2] is double) || !(rect[3] is double))
                {
                    problem($"{name}: \"rect\" must be [x, y, width, height] - ignored.");
                    continue;
                }
                bool valid = true;
                foreach (var value in rect)
                {
                    double number = (double)value;
                    if (double.IsNaN(number) || double.IsInfinity(number) || number < 0 || number > int.MaxValue || number != Math.Truncate(number)) valid = false;
                }
                if (!valid)
                {
                    problem($"{name}: cut coordinates must be non-negative whole numbers within the integer range - ignored.");
                    continue;
                }
                Add(new Frame
                {
                    Name = name,
                    Texture = texture,
                    X = (int)Math.Round((double)rect[0]),
                    Y = (int)Math.Round((double)rect[1]),
                    W = (int)Math.Round((double)rect[2]),
                    H = (int)Math.Round((double)rect[3]),
                });
            }
            if (Frames.Count > 0) ModHost.LogLine($"[ResourcePacks] {Frames.Count} sprite re-cut(s) registered.");
        }

        /// <summary>Add a re-cut, replacing any earlier one for the same sprite.</summary>
        internal static void Add(Frame frame)
        {
            Frames.RemoveAll(f => f.Key == frame.Key);
            Frames.Add(frame);
            ByName.Clear();
            foreach (var f in Frames)
            {
                if (!ByName.TryGetValue(f.Name, out var list)) ByName[f.Name] = list = new List<Frame>();
                list.Add(f);
            }
        }

        internal static void Remove(Frame frame)
        {
            Frames.Remove(frame);
            ByName.Clear();
            foreach (var f in Frames)
            {
                if (!ByName.TryGetValue(f.Name, out var list)) ByName[f.Name] = list = new List<Frame>();
                list.Add(f);
            }
        }

        /// <summary>Forget what was done, so the next pass does it all again.</summary>
        internal static void Reset()
        {
            Done.Clear();
            Pinned.Clear();
            foreach (var f in Frames) f.Applied = false;
        }

        /// <summary>
        /// Re-cut every loaded sprite the pack names. Sprites arrive with the scenes
        /// that use them, so like the sheets this runs repeatedly, not once.
        /// </summary>
        internal static int Apply(Action<string> problem, Frame only = null)
        {
            if (Frames.Count == 0) return 0;
            int applied = 0;
            foreach (var sprite in Resources.FindObjectsOfTypeAll<Sprite>())
            {
                if (sprite == null) continue;
                if (!ByName.TryGetValue(sprite.name, out var candidates)) continue;
                int id = IdOf(sprite);
                if (only == null && Done.Contains(id)) continue;

                var texture = sprite.texture;
                if (texture == null) continue;
                Frame frame = null;
                foreach (var c in candidates) if (c.Texture == texture.name) { frame = c; break; }
                if (frame == null || (only != null && frame != only)) continue;

                Done.Add(id);
                try
                {
                    var refusal = Recut(sprite, texture, frame);
                    if (refusal != null) { problem($"{frame.Name}: {refusal} - left as it was."); continue; }
                }
                catch (Exception ex)
                {
                    problem($"{frame.Name}: could not be re-cut ({ex.Message}).");
                    continue;
                }
                frame.Applied = true;
                Pinned.Add(sprite);
                applied++;
                ModHost.LogLine($"[ResourcePacks] re-cut {frame.Name} on {frame.Texture} to {frame.X},{frame.Y} {frame.W}x{frame.H}.");
            }
            return applied;
        }

        /// <summary>Replace the sprite's mesh with one quad over the new rectangle.
        /// Returns why it was refused, or null when it went through.</summary>
        private static string Recut(Sprite sprite, Texture2D texture, Frame frame)
        {
            int tw = texture.width, th = texture.height;
            if (frame.W <= 0 || frame.H <= 0 || frame.X < 0 || frame.Y < 0 || (long)frame.X + frame.W > tw || (long)frame.Y + frame.H > th)
                return $"the cut {frame.X},{frame.Y} {frame.W}x{frame.H} does not fit on the {tw}x{th} sheet";

            float ppu = sprite.pixelsPerUnit;
            if (ppu <= 0f) return "the sprite has no pixels-per-unit";

            // An atlas-packed sprite can be stored rotated, and its mesh no longer
            // maps onto the sheet by a plain offset. None of the game's catalogued
            // sheets are packed that way; refuse rather than draw it sideways.
            if (sprite.packed && sprite.packingRotation != SpritePackingRotation.None)
                return "the sprite is stored rotated in its atlas";

            // Where the sprite's pivot sits on the sheet, in pixels. The mesh is
            // measured from the pivot, so keeping this point fixed keeps every
            // original pixel exactly where it was on screen. textureRect, not rect:
            // the packer trims transparent margins, and textureRectOffset is how
            // far the trimmed rectangle sits inside the untrimmed one.
            var anchor = sprite.textureRect.position - sprite.textureRectOffset + sprite.pivot;

            // Trust, but check against the mesh the game actually draws: a vertex's
            // position and its UV must agree with that anchor. If they do not, this
            // sprite maps onto its sheet some way this code does not understand.
            var vertices = sprite.vertices;
            var uvs = sprite.uv;
            if (vertices == null || uvs == null || vertices.Length == 0 || vertices.Length != uvs.Length)
                return "the sprite has no mesh to rewrite";
            for (int i = 0; i < vertices.Length; i++)
            {
                float px = uvs[i].x * tw - vertices[i].x * ppu;
                float py = uvs[i].y * th - vertices[i].y * ppu;
                if (Mathf.Abs(px - anchor.x) > 1f || Mathf.Abs(py - anchor.y) > 1f)
                    return "its mesh does not line up with its sheet the way the framework expects";
            }

            float left = (frame.X - anchor.x) / ppu, right = (frame.X + frame.W - anchor.x) / ppu;
            float bottom = (frame.Y - anchor.y) / ppu, top = (frame.Y + frame.H - anchor.y) / ppu;
            float u0 = frame.X / (float)tw, u1 = (frame.X + frame.W) / (float)tw;
            float v0 = frame.Y / (float)th, v1 = (frame.Y + frame.H) / (float)th;

            var positions = new NativeArray<Vector3>(4, Allocator.Temp);
            var coords = new NativeArray<Vector2>(4, Allocator.Temp);
            var indices = new NativeArray<ushort>(6, Allocator.Temp);
            try
            {
                positions[0] = new Vector3(left, bottom, 0f); coords[0] = new Vector2(u0, v0);
                positions[1] = new Vector3(left, top, 0f); coords[1] = new Vector2(u0, v1);
                positions[2] = new Vector3(right, top, 0f); coords[2] = new Vector2(u1, v1);
                positions[3] = new Vector3(right, bottom, 0f); coords[3] = new Vector2(u1, v0);
                indices[0] = 0; indices[1] = 1; indices[2] = 2;
                indices[3] = 0; indices[4] = 2; indices[5] = 3;

                sprite.SetVertexCount(4);
                sprite.SetVertexAttribute(VertexAttribute.Position, positions);
                sprite.SetVertexAttribute(VertexAttribute.TexCoord0, coords);
                sprite.SetIndices(indices);
            }
            finally
            {
                positions.Dispose();
                coords.Dispose();
                indices.Dispose();
            }
            return null;
        }

#pragma warning disable 0618
        private static int IdOf(UnityEngine.Object o) => o.GetInstanceID();
#pragma warning restore 0618
    }
}
