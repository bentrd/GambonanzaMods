using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace Gambonanza.StrainApi
{
    /// <summary>
    /// What StrainApi remembers between sessions, as written to disk. Unity's JsonUtility
    /// reads and writes it, hence public fields.
    /// </summary>
    [Serializable]
    internal sealed class StrainSaveData
    {
        /// <summary>Strain ids the player picked for their next run.</summary>
        public List<string> selected = new List<string>();

        /// <summary>
        /// True once a run has started and until another one does. The game's own save
        /// is what decides whether that run can be continued; this only records which
        /// strains it was started with, so continuing it brings them back.
        /// </summary>
        public bool runRecorded;

        /// <summary>The strains the recorded run was started with.</summary>
        public List<string> runStrains = new List<string>();
    }

    /// <summary>
    /// Loads and saves <see cref="StrainSaveData"/> under the game's persistent data
    /// folder rather than the mod folder: the mod manager replaces a mod's folder
    /// wholesale when it updates it, which would forget the player's picks and strand a
    /// saved run without its strains.
    /// </summary>
    internal static class StrainStore
    {
        private const string FolderName = "GambonanzaMods";
        private const string FileName = "StrainApi.json";

        internal static StrainSaveData Data { get; private set; } = new StrainSaveData();

        internal static string FilePath
        {
            get
            {
                try { return Path.Combine(Application.persistentDataPath, FolderName, FileName); }
                catch { return null; }
            }
        }

        internal static void Load()
        {
            var path = FilePath;
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) { Data = new StrainSaveData(); return; }
            try
            {
                var loaded = JsonUtility.FromJson<StrainSaveData>(File.ReadAllText(path)) ?? new StrainSaveData();
                loaded.selected = Clean(loaded.selected);
                loaded.runStrains = Clean(loaded.runStrains);
                Data = loaded;
            }
            catch (Exception ex)
            {
                // Keep the unreadable file for inspection instead of silently overwriting it.
                StrainCore.Log($"{path} is unreadable ({ex.Message}); starting with no strains picked. " +
                               "It will be replaced on the next change; a copy is kept as StrainApi.json.bad.");
                try { File.Copy(path, path + ".bad", overwrite: true); } catch { }
                Data = new StrainSaveData();
            }
        }

        internal static void Save()
        {
            var path = FilePath;
            if (string.IsNullOrEmpty(path)) return;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                // Write-then-swap so a crash mid-write can never leave a truncated file.
                var temp = path + ".tmp";
                File.WriteAllText(temp, JsonUtility.ToJson(Data, true));
                if (File.Exists(path)) File.Delete(path);
                File.Move(temp, path);
            }
            catch (Exception ex) { StrainCore.Log($"could not save {path}: {ex.Message}"); }
        }

        private static List<string> Clean(List<string> ids)
        {
            var result = new List<string>();
            if (ids == null) return result;
            foreach (var id in ids)
                if (!string.IsNullOrWhiteSpace(id) && !result.Contains(id)) result.Add(id);
            return result;
        }
    }
}
