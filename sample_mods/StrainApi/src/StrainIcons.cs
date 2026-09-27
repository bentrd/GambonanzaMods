using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace Gambonanza.StrainApi
{
    /// <summary>
    /// Finds the sprite for a strain's card: the sprite it was given, else its PNG file,
    /// else the game sprite it named, else StrainApi's own default icon. Loaded the first
    /// time a card needs it (textures need Unity's main thread, registration may not be
    /// on it) and cached for the session.
    /// </summary>
    internal static class StrainIcons
    {
        private const string DefaultIconResource = "Gambonanza.StrainApi.default-strain.png";

        private static readonly Dictionary<string, Sprite> _byPath = new Dictionary<string, Sprite>(StringComparer.OrdinalIgnoreCase);
        private static Dictionary<string, Sprite> _gameSprites;
        private static Sprite _default;

        internal static Sprite For(StrainDefinition def)
        {
            if (def == null) return Default();
            if (def.Icon) return def.Icon;

            Sprite sprite = null;
            if (!string.IsNullOrEmpty(def.IconFile)) sprite = FromFile(def);
            if (!sprite && !string.IsNullOrEmpty(def.GameIconName)) sprite = FromGame(def);
            if (sprite) def.Icon = sprite;
            return sprite ? sprite : Default();
        }

        private static Sprite FromFile(StrainDefinition def)
        {
            var path = def.IconFile;
            try
            {
                if (!Path.IsPathRooted(path) && !string.IsNullOrEmpty(def.SourceDirectory))
                    path = Path.Combine(def.SourceDirectory, path);
                if (_byPath.TryGetValue(path, out var cached)) return cached;
                if (!File.Exists(path))
                {
                    StrainCore.Log($"[{def.Id}] icon file not found: {path}; using the default icon.");
                    return null;
                }
                var sprite = Load(File.ReadAllBytes(path), def.Id);
                _byPath[path] = sprite;
                return sprite;
            }
            catch (Exception ex)
            {
                StrainCore.Log($"[{def.Id}] could not load icon {path}: {ex.Message}; using the default icon.");
                return null;
            }
        }

        private static Sprite FromGame(StrainDefinition def)
        {
            if (_gameSprites == null)
            {
                _gameSprites = new Dictionary<string, Sprite>(StringComparer.Ordinal);
                foreach (var s in Resources.FindObjectsOfTypeAll<Sprite>())
                    if (s && !_gameSprites.ContainsKey(s.name)) _gameSprites.Add(s.name, s);
            }
            if (_gameSprites.TryGetValue(def.GameIconName, out var sprite) && sprite) return sprite;
            StrainCore.Log($"[{def.Id}] no game sprite named '{def.GameIconName}'; using the default icon.");
            return null;
        }

        private static Sprite Default()
        {
            if (_default) return _default;
            try
            {
                using (var stream = typeof(StrainIcons).Assembly.GetManifestResourceStream(DefaultIconResource))
                {
                    if (stream == null) return null;
                    var bytes = new byte[stream.Length];
                    int read = 0;
                    while (read < bytes.Length)
                    {
                        int n = stream.Read(bytes, read, bytes.Length - read);
                        if (n <= 0) break;
                        read += n;
                    }
                    _default = Load(bytes, "default");
                }
            }
            catch (Exception ex) { StrainCore.Log("could not load the default strain icon: " + ex.Message); }
            return _default;
        }

        /// <summary>A PNG as a point-filtered sprite, the way the game draws its pixel art.</summary>
        private static Sprite Load(byte[] png, string name)
        {
            var texture = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            if (!texture.LoadImage(png)) throw new InvalidDataException("not a PNG the game can read");
            texture.filterMode = FilterMode.Point;
            texture.wrapMode = TextureWrapMode.Clamp;
            texture.name = "StrainIcon " + name;
            var sprite = Sprite.Create(texture, new Rect(0, 0, texture.width, texture.height), new Vector2(0.5f, 0.5f), 100f);
            sprite.name = texture.name;
            // Session-long, like the game's own sprites: never unloaded between scenes.
            texture.hideFlags = HideFlags.DontUnloadUnusedAsset;
            sprite.hideFlags = HideFlags.DontUnloadUnusedAsset;
            return sprite;
        }
    }
}
