using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Gambonanza.ModSdk;
using UnityEngine;

namespace Gambonanza.CollectionProfiler
{
    /// <summary>
    /// Drives the A/B sweep. While the collection is open it disables one suspected
    /// cause at a time for a few seconds and records frame times, so each cause gets
    /// a measured cost instead of an argued one.
    /// </summary>
    public sealed class CollectionProfilerRunner : MonoBehaviour
    {
        private const float WarmupSeconds = 0.6f;   // let the switch settle before sampling
        private const float SampleSeconds = 3.0f;
        private const float BurstSeconds = 0.7f;   // covers the 0.45s spacing tween + slack

        private IModContext _ctx;
        private readonly CollectionTargets _targets = new CollectionTargets();
        private List<ExperimentConfig> _configs;
        private readonly FrameStats _menuBaseline = new FrameStats();

        private int _configIndex;
        private float _phaseStarted;
        private bool _sampling;
        private bool _wasOpen;
        private int _lastPageIndex = -1;
        private float _burstUntil;
        private int _laps;

        private string _census;
        private int _canvasFlushesThisFrame;
        private bool _reportWritten;

        public void Bind(IModContext ctx)
        {
            _ctx = ctx;
            _configs = new List<ExperimentConfig>
            {
                new ExperimentConfig("vanilla",           Knob.None),
                new ExperimentConfig("no_idle_rotation",  Knob.NoIdleRotation),
                new ExperimentConfig("no_uifx_filters",   Knob.NoUifxFilters),
                new ExperimentConfig("no_mesh_effects",   Knob.NoMeshEffects),
                new ExperimentConfig("no_autolayout",     Knob.NoAutoLayout),
                new ExperimentConfig("no_grid_tween",     Knob.NoGridTween),
                new ExperimentConfig("card_subcanvas",    Knob.CardSubCanvas),
                new ExperimentConfig("no_mod_pagination", Knob.NoModPagination),
                new ExperimentConfig("all_combined",      Knob.NoIdleRotation | Knob.NoUifxFilters |
                                                          Knob.NoMeshEffects | Knob.NoAutoLayout |
                                                          Knob.NoGridTween | Knob.NoModPagination),
            };
            Canvas.willRenderCanvases += OnWillRenderCanvases;
        }

        private void OnWillRenderCanvases() => _canvasFlushesThisFrame++;

        private void Update()
        {
            // Read and reset the counter first: willRenderCanvases fired during last
            // frame's render, after our previous Update. 1/frame is normal; anything
            // above that is a Canvas.ForceUpdateCanvases() call.
            int extraFlushes = Mathf.Max(0, _canvasFlushesThisFrame - 1);
            _canvasFlushesThisFrame = 0;

            float ms = Time.unscaledDeltaTime * 1000f;

            if (!_targets.TryBind()) return;

            bool open = _targets.IsOpen;

            if (!open)
            {
                if (_wasOpen) OnCollectionClosed();
                _menuBaseline.Add(ms);
                return;
            }

            if (!_wasOpen) OnCollectionOpened();
            _wasOpen = true;

            var cfg = _configs[_configIndex];
            _targets.Tick(cfg.Knobs);

            // A page turn restarts the spacing tween, so it re-triggers the burst.
            int page = _targets.PageIndex;
            if (page != _lastPageIndex)
            {
                _lastPageIndex = page;
                _burstUntil = Time.unscaledTime + BurstSeconds;
            }

            float elapsed = Time.unscaledTime - _phaseStarted;
            if (!_sampling)
            {
                if (elapsed >= WarmupSeconds) { _sampling = true; _phaseStarted = Time.unscaledTime; }
                return;
            }

            var bucket = Time.unscaledTime < _burstUntil ? cfg.Burst : cfg.Steady;
            bucket.Add(ms);
            bucket.ExtraCanvasFlushes += extraFlushes;

            if (elapsed >= SampleSeconds) AdvanceConfig();
        }

        private void OnCollectionOpened()
        {
            if (_census == null)
            {
                try { _census = SceneCensus.Describe(_targets.Root); }
                catch (Exception ex) { _census = "census failed: " + ex.Message; }
                Log($"bound to collection - {_targets.IconCount} cards, {_targets.MeshEffectCount} mesh effects, " +
                    $"{_targets.UifxCount} UIFX filters, {_targets.AutoLayoutCount} AutoLayoutRebuilders.");
                Log($"sweep running ({_configs.Count} configs, ~{_configs.Count * (WarmupSeconds + SampleSeconds):F0}s " +
                    "per lap) - browse the collection, turn pages, hover cards.");
            }
            _configIndex = 0;
            StartPhase();
            _burstUntil = Time.unscaledTime + BurstSeconds; // opening itself runs the tween
            _lastPageIndex = _targets.PageIndex;
        }

        private void OnCollectionClosed()
        {
            _wasOpen = false;
            _targets.Revert();
            WriteReport("collection closed");
        }

        private void StartPhase()
        {
            var cfg = _configs[_configIndex];
            try { _targets.Apply(cfg.Knobs); }
            catch (Exception ex) { Log($"applying {cfg.Name} failed: {ex.Message}"); }
            _phaseStarted = Time.unscaledTime;
            _sampling = false;
        }

        private void AdvanceConfig()
        {
            _configIndex++;
            if (_configIndex >= _configs.Count)
            {
                _configIndex = 0;
                _laps++;
                Log($"sweep lap {_laps} complete.");
            }
            StartPhase();
        }

        private void OnApplicationQuit()
        {
            _targets.Revert();
            WriteReport("application quit");
        }

        public void TearDown()
        {
            Canvas.willRenderCanvases -= OnWillRenderCanvases;
            _targets.Revert();
            WriteReport("mod disabled");
        }

        private void Log(string msg) => _ctx?.LogLine(msg);

        private void WriteReport(string reason)
        {
            if (_configs == null) return;
            var vanilla = _configs[0];
            if (vanilla.Steady.Count < 30)
            {
                if (!_reportWritten) Log($"no report ({reason}): only {vanilla.Steady.Count} baseline samples - " +
                                         "stay in the collection for ~30s.");
                return;
            }

            var sb = new StringBuilder();
            sb.AppendLine("# Gambonanza collection - measured profile");
            sb.AppendLine();
            sb.AppendLine($"- written because: {reason}");
            sb.AppendLine($"- sweep laps completed: {_laps}");
            sb.AppendLine($"- menu baseline (collection closed): median {_menuBaseline.Median:F2} ms " +
                          $"({_menuBaseline.MedianFps:F0} fps), {_menuBaseline.Count} frames");
            sb.AppendLine();
            sb.AppendLine(_census ?? "");

            sb.AppendLine("## Steady state (collection open, no page turn in flight)");
            sb.AppendLine();
            sb.AppendLine("| config | median ms | fps | p95 ms | p99 ms | vs vanilla | frames | extra canvas flushes |");
            sb.AppendLine("|---|---|---|---|---|---|---|---|");
            foreach (var c in _configs) AppendRow(sb, c, c.Steady, vanilla.Steady);

            sb.AppendLine();
            sb.AppendLine("## Page-turn burst (first 0.7s after open / page change)");
            sb.AppendLine();
            sb.AppendLine("| config | median ms | p95 ms | worst ms | vs vanilla (p95) | frames |");
            sb.AppendLine("|---|---|---|---|---|---|");
            foreach (var c in _configs)
            {
                float d = vanilla.Burst.P95 > 0f ? (c.Burst.P95 - vanilla.Burst.P95) / vanilla.Burst.P95 * 100f : 0f;
                string delta = ReferenceEquals(c, vanilla) ? "-" : $"{d:+0.0;-0.0;0}%";
                sb.AppendLine($"| {c.Name} | {c.Burst.Median:F2} | {c.Burst.P95:F2} | {c.Burst.Worst:F2} | " +
                              $"{delta} | {c.Burst.Count} |");
            }

            sb.AppendLine();
            sb.AppendLine("Each config disables ONE suspected cause (except `all_combined`). ");
            sb.AppendLine("A large negative `vs vanilla` means that cause was expensive.");

            string path = Path.Combine(Application.persistentDataPath, "collection_profile.md");
            try
            {
                File.WriteAllText(path, sb.ToString());
                Log($"report written to {path}");
            }
            catch (Exception ex)
            {
                Log($"could not write report: {ex.Message}");
            }

            // Also to Player.log, so the data survives even if the file write fails.
            Log("--- steady-state summary ---");
            foreach (var c in _configs)
            {
                float d = vanilla.Steady.Median > 0f
                    ? (c.Steady.Median - vanilla.Steady.Median) / vanilla.Steady.Median * 100f : 0f;
                Log($"  {c.Name,-18} median {c.Steady.Median,6:F2} ms  ({c.Steady.MedianFps,5:F0} fps)  " +
                    $"p95 {c.Steady.P95,6:F2}  delta {d,6:+0.0;-0.0;0}%  n={c.Steady.Count}  " +
                    $"burstP95 {c.Burst.P95,6:F2}  flushes={c.Steady.ExtraCanvasFlushes}");
            }
            _reportWritten = true;
        }

        private static void AppendRow(StringBuilder sb, ExperimentConfig c, FrameStats s, FrameStats baseline)
        {
            float d = baseline.Median > 0f ? (s.Median - baseline.Median) / baseline.Median * 100f : 0f;
            string delta = ReferenceEquals(s, baseline) ? "-" : $"{d:+0.0;-0.0;0}%";
            sb.AppendLine($"| {c.Name} | {s.Median:F2} | {s.MedianFps:F0} | {s.P95:F2} | {s.P99:F2} | " +
                          $"{delta} | {s.Count} | {s.ExtraCanvasFlushes} |");
        }
    }
}
