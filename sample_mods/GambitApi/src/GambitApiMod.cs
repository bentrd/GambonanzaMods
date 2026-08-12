using System.Collections;
using Blukulele.CHE;
using Blukulele.Core;
using Gambonanza.ModSdk;
using UnityEngine;

namespace Gambonanza.GambitApi
{
    /// <summary>
    /// Entry point for the GambitApi library mod. Other mods reference this DLL and use
    /// <c>GambitBuilder</c> to register custom gambits - the actual registration is deferred
    /// here until the vanilla <c>GambitLibrary</c> singleton has fully initialised, since
    /// custom gambits can only be inserted after the game has built its internal lookup tables.
    /// </summary>
    public class GambitApiMod : IMod
    {
        public static GambitApiMod Instance { get; private set; }
        public IModContext Context { get; private set; }

        public void OnLoad(IModContext context)
        {
            Instance = this;
            Context = context;
            context.LogLine("[GambitApi] OnLoad called.");
            Debug.Log("[GambitApi] OnLoad called. Creating host...");

            var host = new GameObject("GambitApiHost");
            UnityEngine.Object.DontDestroyOnLoad(host);
            var runner = host.AddComponent<GambitApiHost>();
            host.AddComponent<CollectionInputHandler>();
            runner.StartCoroutine(InitializeRoutine());
        }

        private static IEnumerator InitializeRoutine()
        {
            Debug.Log("[GambitApi] InitializeRoutine started. Waiting for GambitLibrary to be fully initialized...");

            int waitFrames = 0;
            while (true)
            {
                var library = SingletonMonoBehaviour<GambitLibrary>.Instance;
                bool libraryExists = library != null;
                bool hasInfo = libraryExists && library.GambitsInfo != null && library.GambitsInfo.Count > 0;

                // Check if Initialize() has run by looking for m_FocusMap
                bool initialized = false;
                if (libraryExists)
                {
                    var focusMapField = typeof(GambitLibrary).GetField("m_FocusMap", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                    initialized = focusMapField?.GetValue(library) != null;
                }

                if (libraryExists && hasInfo && initialized)
                {
                    Debug.Log($"[GambitApi] GambitLibrary fully initialized after {waitFrames} frames. Count={library.GambitsInfo.Count}, m_FocusMap exists={initialized}");
                    break;
                }

                if (waitFrames % 60 == 0)
                {
                    Debug.Log($"[GambitApi] Waiting for GambitLibrary... exists={libraryExists}, hasInfo={hasInfo}, initialized={initialized}, frames={waitFrames}");
                }

                yield return null;
                waitFrames++;

                if (waitFrames > 600)
                {
                    Debug.LogError("[GambitApi] TIMED OUT waiting for GambitLibrary Initialize() after 600 frames (~10s).");
                    break;
                }
            }

            yield return null;

            Debug.Log("[GambitApi] Processing pending registrations...");
            GambitRegistry.ProcessPending();

            // Everything that registers this session has registered - sweep save
            // data for gambit ids whose mods were removed or disabled.
            GambitRegistry.PurgeStaleUnlockData();

            Debug.Log("[GambitApi] InitializeRoutine complete.");
        }
    }

    /// <summary>
    /// Scene-persistent runner for GambitApi coroutines. Also keeps injected gambit
    /// localization alive: the game rebuilds its traduction cache from the vanilla
    /// text asset on every language change, dropping modded entries, so we re-inject
    /// on <c>LocalizationManager.OnChangeLanguage</c> and from a 2-second watchdog
    /// (the Steam first-launch language auto-detect never fires the event).
    /// </summary>
    public class GambitApiHost : MonoBehaviour
    {
        private bool _subscribed;
        private float _nextWatchdogTick;

        // One-shot collection frame probe: the first time the collection stays
        // open, sample ~5s of frame times and log ONE diagnostic line. Costs
        // nothing afterwards, and turns "the collection lags" bug reports into
        // actionable numbers in Player.log.
        private bool _probeDone;
        private int _probeFrames;
        private float _probeSum;
        private float _probeWorst;

        private void Update()
        {
            if (!_subscribed && SingletonMonoBehaviour<LocalizationManager>.IsCreated())
            {
                var loc = SingletonMonoBehaviour<LocalizationManager>.Instance;
                if (loc != null)
                {
                    loc.OnChangeLanguage += OnLanguageChanged;
                    _subscribed = true;
                }
            }

            if (Time.unscaledTime >= _nextWatchdogTick)
            {
                _nextWatchdogTick = Time.unscaledTime + 2f;
                GambitRegistry.EnsureLocalizationInjected();
            }

            if (!_probeDone) SampleCollectionFrame();
        }

        private void SampleCollectionFrame()
        {
            var gm = SingletonMonoBehaviour<GameManager>.IsCreated()
                ? SingletonMonoBehaviour<GameManager>.Instance : null;
            if (gm == null || gm.CurrentState != State.COLLECTION)
            {
                _probeFrames = 0; _probeSum = 0f; _probeWorst = 0f;
                return;
            }

            float dt = Time.unscaledDeltaTime;
            _probeFrames++;
            _probeSum += dt;
            if (dt > _probeWorst) _probeWorst = dt;

            if (_probeSum >= 5f && _probeFrames > 30)
            {
                _probeDone = true;
                float avgMs = _probeSum / _probeFrames * 1000f;
                int count = SingletonMonoBehaviour<GambitLibrary>.IsCreated()
                    ? (SingletonMonoBehaviour<GambitLibrary>.Instance?.GambitsInfo?.Count ?? -1) : -1;
                Debug.Log($"[GambitApi][perf] collection open: avg {avgMs:F1} ms/frame ({1000f / avgMs:F0} fps), worst {_probeWorst * 1000f:F1} ms, library count {count}. " +
                          (avgMs > 25f ? "That is SLOW - please share Player.log when reporting." : "Frame rate looks healthy."));
            }
        }

        private void OnDestroy()
        {
            if (_subscribed && SingletonMonoBehaviour<LocalizationManager>.IsCreated())
            {
                var loc = SingletonMonoBehaviour<LocalizationManager>.Instance;
                if (loc != null) loc.OnChangeLanguage -= OnLanguageChanged;
            }
        }

        private void OnLanguageChanged() => GambitRegistry.EnsureLocalizationInjected();
    }
}
