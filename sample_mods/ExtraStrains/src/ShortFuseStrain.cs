using Gambonanza.CrumbleApi;
using Gambonanza.StrainApi;

namespace Gambonanza.ExtraStrains
{
    /// <summary>
    /// Short Fuse: every game, the crumble countdown starts <see cref="TurnsSooner"/>
    /// turns in, so the board starts crumbling that much earlier.
    ///
    /// A StrainBehaviour rather than builder delegates because it keeps state. The
    /// countdown can only be pushed once the game has reset it for the new game, which
    /// it has by the player's first turn - so OnGameStarted arms a flag and the first
    /// OnPlayerTurn of the game spends it. One instance lives exactly as long as the
    /// strain is on the run being played, so the flag needs no other bookkeeping, and a
    /// run continued mid-game (no OnGameStarted) is never pushed twice: the game saved
    /// the counter with the run.
    ///
    /// The crumble is private to the game; CrumbleApi, another library mod, is what makes
    /// the countdown writable, and it keeps the indicator lights under the board in step.
    /// </summary>
    public sealed class ShortFuseStrain : StrainBehaviour
    {
        public const string StrainId = "short-fuse";
        public const int TurnsSooner = 2;

        private bool _armed;

        protected override void OnGameStarted() => _armed = true;

        protected override void OnGameEnded() => _armed = false;

        protected override void OnPlayerTurn()
        {
            if (!_armed) return;
            _armed = false;
            if (!Crumble.IsBound || Crumble.IsActive) return;
            Crumble.TurnCounter += TurnsSooner;
            Log($"fuse lit: the crumble countdown is at {Crumble.TurnCounter}/{Crumble.Threshold}.");
        }
    }
}
