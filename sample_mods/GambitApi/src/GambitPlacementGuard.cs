using Blukulele.CHE;
using DG.Tweening;
using UnityEngine;

namespace Gambonanza.GambitApi
{
    /// <summary>
    /// Attached to every modded gambit prefab by <c>GambitRegistry.BuildPrefab</c>.
    ///
    /// When the player buys a gambit or takes one from a token, vanilla parents
    /// the new instance to its GambitPlaceBehaviour and schedules DELAYED tweens
    /// (DOScale + DOFollow/DOLocalMove with a 0.3s delay) that fly it into the
    /// slot. A gambit whose behaviour fires Trigger()/VisualEffect() while it is
    /// spawning (Impatient does, on acquisition between games) runs vanilla
    /// HighlightEffect(), whose transform.DOKill() also kills those still-pending
    /// tweens - the icon stays stranded wherever it spawned and the stock slot
    /// looks empty until the player swaps something over it.
    ///
    /// This waits out the spawn animation once and snaps the transform into its
    /// slot if the tween died on the way.
    /// </summary>
    public class GambitPlacementGuard : MonoBehaviour
    {
        // Spawn tweens start at 0.3s and run 0.2-0.3s; by 1s a live tween has
        // either landed or is mid-flight (and IsTweening sees it).
        private const float CheckDelay = 1.0f;

        private float _checkAt;
        private bool _done;

        private void OnEnable()
        {
            if (_done) return;
            _checkAt = Time.unscaledTime + CheckDelay;
        }

        private void LateUpdate()
        {
            if (_done) { enabled = false; return; }
            if (Time.unscaledTime < _checkAt) return;

            // A live tween still owns the transform - let it land.
            if (DOTween.IsTweening(base.transform)) { _checkAt = Time.unscaledTime + 0.5f; return; }

            _done = true;
            enabled = false;

            // Only gambits sitting in a stock place have a "home" to snap to;
            // vanilla parks them at local (0, 0, -1) there.
            if (GetComponentInParent<GambitPlaceBehaviour>() == null) return;
            Vector3 local = base.transform.localPosition;
            if (Mathf.Abs(local.x) < 0.05f && Mathf.Abs(local.y) < 0.05f) return;

            base.transform.localPosition = Vector3.forward * -1f;
            base.transform.localScale = Vector3.one;
            Debug.Log($"[GambitApi] '{name}' lost its spawn tween (a gambit triggering during its own spawn kills it) - snapped it into its stock slot.");
        }
    }
}
