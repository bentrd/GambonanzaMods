using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace Gambonanza.ModHost
{
    /// <summary>Resolve clips at playback, including music and randomized effects.
    /// New clips allow any duration and avoid writing into compressed vanilla clips.</summary>
    public static class ResourcePackAudio
    {
        private static readonly Dictionary<string, string> Files = new Dictionary<string, string>(StringComparer.Ordinal);
        private static readonly Dictionary<string, AudioClip> Clips = new Dictionary<string, AudioClip>(StringComparer.Ordinal);
        private static readonly HashSet<string> Failed = new HashSet<string>(StringComparer.Ordinal);
        internal static int AppliedCount => Clips.Count;

        internal static void Load(Dictionary<string, object> root, Func<string, string> resolve)
        {
            foreach (var raw in TinyJson.Array(root, "audio"))
            {
                var item = TinyJson.AsObject(raw);
                if (item == null) continue;
                var name = TinyJson.Str(item, "name");
                var file = resolve(TinyJson.Str(item, "file"));
                if (!string.IsNullOrEmpty(name) && file != null) Files[name] = file;
            }
            ModHost.LogLine($"[ResourcePacks] {Files.Count} audio override(s) registered.");
        }

        // Injected into AudioManager.ChooseRandomClip before every return.
        // Lazy decoding means unused music does not occupy memory.
        public static AudioClip Resolve(AudioClip original)
        {
            if (original == null || !Files.TryGetValue(original.name, out var file)) return original;
            var name = original.name;
            if (Clips.TryGetValue(name, out var held)) return held;
            if (Failed.Contains(name)) return original;
            try
            {
                var clip = ReadWave(file, name);
                Clips[name] = clip;
                ModHost.LogLine($"[ResourcePacks] audio {name}: loaded replacement ({clip.length:F2}s, {clip.frequency} Hz).");
                return clip;
            }
            catch (Exception ex)
            {
                Failed.Add(name);
                ModHost.LogLine($"[ResourcePacks] audio {name}: {ex.Message}; using original.");
                return original;
            }
        }

        internal static AudioClip ReadWave(string file, string name)
        {
            const int max = 128 * 1024 * 1024;
            var length = new FileInfo(file).Length;
            if (length < 44 || length > max) throw new Exception("invalid WAV size");
            var b = File.ReadAllBytes(file);
            using (var reader = new BinaryReader(new MemoryStream(b)))
            {
                if (new string(reader.ReadChars(4)) != "RIFF" || reader.ReadUInt32() + 8L != b.Length
                    || new string(reader.ReadChars(4)) != "WAVE") throw new Exception("invalid WAV header");
                int format = 0, channels = 0, rate = 0, bits = 0, align = 0, byteRate = 0;
                int start = 0, size = 0;
                bool hasFormat = false, hasData = false;
                while (reader.BaseStream.Position + 8 <= b.Length)
                {
                    var tag = new string(reader.ReadChars(4));
                    long count = reader.ReadUInt32();
                    long end = reader.BaseStream.Position + count;
                    if (end > b.Length) throw new Exception("truncated WAV chunk");
                    if (tag == "fmt ")
                    {
                        if (hasFormat || count < 16) throw new Exception("invalid WAV format chunk");
                        hasFormat = true;
                        format = reader.ReadUInt16(); channels = reader.ReadUInt16();
                        rate = reader.ReadInt32(); byteRate = reader.ReadInt32();
                        align = reader.ReadUInt16(); bits = reader.ReadUInt16();
                    }
                    if (tag == "data")
                    {
                        if (hasData) throw new Exception("duplicate WAV data chunk");
                        hasData = true; start = (int)reader.BaseStream.Position; size = (int)count;
                    }
                    reader.BaseStream.Position = end + (count & 1);
                    if (reader.BaseStream.Position > b.Length) throw new Exception("missing WAV padding");
                }
                if (!hasFormat || !hasData || size <= 0 || channels < 1 || channels > 2 || rate < 8000 || rate > 192000
                    || !((format == 1 && bits == 16) || (format == 3 && bits == 32))
                    || align != channels * bits / 8 || byteRate != rate * align || size % align != 0)
                    throw new Exception("use PCM 16-bit or float 32-bit mono/stereo WAV");
                var samples = new float[size / (bits / 8)];
                for (int i = 0, pos = start; i < samples.Length; i++, pos += bits / 8)
                {
                    float value = format == 1 ? BitConverter.ToInt16(b, pos) / 32768f : BitConverter.ToSingle(b, pos);
                    if (float.IsNaN(value) || float.IsInfinity(value) || Math.Abs(value) > 1)
                        throw new Exception("invalid WAV sample");
                    samples[i] = value;
                }
                var clip = AudioClip.Create(name, samples.Length / channels, channels, rate, false);
                if (!clip.SetData(samples, 0)) { UnityEngine.Object.Destroy(clip); throw new Exception("engine refused audio samples"); }
                return clip;
            }
        }
    }
}
