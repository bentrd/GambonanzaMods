using System.Collections.Generic;

namespace Gambonanza.CollectionProfiler
{
    /// <summary>
    /// A bucket of frame-time samples (milliseconds). Percentiles matter more than
    /// the mean here: a screen that averages 8 ms but spikes to 60 ms every page
    /// turn reads as "smooth" in a mean and as a stutter to the player.
    /// </summary>
    public sealed class FrameStats
    {
        // ~5 min of samples at 240fps. Beyond that we stop growing so a player who
        // leaves the collection open forever can't balloon the heap.
        private const int MaxSamples = 72000;

        private readonly List<float> _ms = new List<float>();
        private int _dropped;

        public int Count => _ms.Count;
        public int Dropped => _dropped;

        /// <summary>Extra Canvas.willRenderCanvases invocations seen in this bucket.</summary>
        public long ExtraCanvasFlushes;

        public void Add(float milliseconds)
        {
            if (_ms.Count < MaxSamples) _ms.Add(milliseconds);
            else _dropped++;
        }

        public void Clear()
        {
            _ms.Clear();
            _dropped = 0;
            ExtraCanvasFlushes = 0;
        }

        private float Percentile(float p)
        {
            if (_ms.Count == 0) return 0f;
            var sorted = new List<float>(_ms);
            sorted.Sort();
            int idx = (int)(p * (sorted.Count - 1));
            if (idx < 0) idx = 0;
            if (idx >= sorted.Count) idx = sorted.Count - 1;
            return sorted[idx];
        }

        public float Median => Percentile(0.50f);
        public float P95 => Percentile(0.95f);
        public float P99 => Percentile(0.99f);

        public float Worst
        {
            get
            {
                float w = 0f;
                for (int i = 0; i < _ms.Count; i++) if (_ms[i] > w) w = _ms[i];
                return w;
            }
        }

        public float Mean
        {
            get
            {
                if (_ms.Count == 0) return 0f;
                double sum = 0;
                for (int i = 0; i < _ms.Count; i++) sum += _ms[i];
                return (float)(sum / _ms.Count);
            }
        }

        /// <summary>FPS implied by the median frame time.</summary>
        public float MedianFps => Median > 0f ? 1000f / Median : 0f;
    }
}
