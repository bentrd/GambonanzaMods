namespace Gambonanza.StrainApi
{
    /// <summary>
    /// What a game state means for following a run. StrainCore maps the game's State
    /// enum onto these, which keeps <see cref="RunTracker"/> free of game and Unity types
    /// (and testable on a bare .NET runtime).
    /// </summary>
    internal enum RunPhase
    {
        /// <summary>Pause, settings, run info, promotion, the collection...: changes nothing.</summary>
        Other,

        /// <summary>MENU, the main menu. Every way out of a run ends there.</summary>
        Menu,

        /// <summary>LOAD_RUN: the game is loading a saved run for Continue.</summary>
        Loading,

        /// <summary>PIECE_SELECTION (the run-start piece wheel) and BOARD_PLACEMENT: a run or a game is being set up.</summary>
        Opening,

        /// <summary>INGAME: a game (one match) is being played.</summary>
        Game,

        /// <summary>SHOP.</summary>
        Shop,

        /// <summary>The other states that only happen inside a run: WIN, RESULT, LOSE, GRAVEYARD, the tile, gachapon, wheel and pachinko screens.</summary>
        Between,
    }

    /// <summary>What <see cref="RunTracker"/> reports, in the order things happen.</summary>
    internal interface IRunListener
    {
        void RunStarted();
        void RunResumed(string reason);
        void RunLeft(string reason);
        void GameStarted();
        void GameEnded();
        void ShopOpened();
    }

    /// <summary>
    /// Works out, from the sequence of game states, when a run starts, is continued and
    /// is left, and when each game starts and ends. The rules:
    ///   - Menu leaves the run.
    ///   - Loading (Continue) leaves any run still marked live, and makes the next run
    ///     state a RESUME of the saved run rather than a new one.
    ///   - Any run state while not in a run starts a NEW run.
    ///   - Game starts a game unless one is already on: the game re-enters INGAME after
    ///     pause, settings, run info and promotion, and that is the same game carrying on.
    ///     Every other run state ends the game that was on.
    ///   - "Started" reports are for things that actually start: a resume reports neither
    ///     GameStarted nor ShopOpened, even when it lands in a game or the shop - though a
    ///     game resumed into still reports GameEnded when it ends.
    ///   - Fallback: the wave count going backwards at an Opening means the last run is
    ///     over and a new one began (only a new run restarts the count), in case the Menu
    ///     signal was ever missed.
    /// </summary>
    internal sealed class RunTracker
    {
        private readonly IRunListener _listener;
        private bool _resumePending;
        private int _lastWave = -1;

        internal RunTracker(IRunListener listener) => _listener = listener;

        internal bool InRun { get; private set; }
        internal bool InGame { get; private set; }

        /// <summary>
        /// Coming online (boot, or StrainApi enabled mid-session) is not a transition: a
        /// run already in progress is the one the player was playing, so it is resumed -
        /// never started.
        /// </summary>
        internal void CatchUp(RunPhase phase, int wave)
        {
            if (phase == RunPhase.Loading) { _resumePending = true; return; }
            if (InRun || !IsInRun(phase)) return;
            Resume(phase, wave, "StrainApi came online mid-run");
        }

        /// <param name="phase">The phase of the state just entered.</param>
        /// <param name="previousWasLoading">The game's PreviousState is LOAD_RUN.</param>
        /// <param name="wave">The run's wave count (ChessDataManager.CurrentWave), or -1 if unknown.</param>
        internal void OnPhase(RunPhase phase, bool previousWasLoading, int wave)
        {
            switch (phase)
            {
                case RunPhase.Other:
                    return;
                case RunPhase.Menu:
                    _resumePending = false;
                    Leave("back at the main menu");
                    return;
                case RunPhase.Loading:
                    // Anything still live belongs to a run the Menu signal somehow missed.
                    Leave("a saved run is being loaded");
                    _resumePending = true;
                    return;
            }

            if (!InRun && (_resumePending || previousWasLoading))
            {
                Resume(phase, wave, "the saved run was continued");
                return;
            }

            if (!InRun) Start(wave);
            else if (phase == RunPhase.Opening && wave >= 0 && _lastWave >= 0 && wave < _lastWave)
            {
                Leave("the wave count restarted, so the last run is over");
                Start(wave);
            }
            if (wave >= 0) _lastWave = wave;
            UpdateGame(phase);
        }

        /// <summary>Forget everything without reporting (StrainApi disabled); the next CatchUp starts afresh.</summary>
        internal void Reset()
        {
            InRun = InGame = _resumePending = false;
            _lastWave = -1;
        }

        private static bool IsInRun(RunPhase phase)
            => phase == RunPhase.Opening || phase == RunPhase.Game || phase == RunPhase.Shop || phase == RunPhase.Between;

        private void Start(int wave)
        {
            InRun = true;
            InGame = false;
            _resumePending = false;
            _lastWave = wave;
            _listener.RunStarted();
        }

        private void Resume(RunPhase phase, int wave, string reason)
        {
            InRun = true;
            // Back in the middle of things: nothing is starting, so no GameStarted or
            // ShopOpened - but a game resumed into still gets its GameEnded.
            InGame = phase == RunPhase.Game;
            _resumePending = false;
            _lastWave = wave;
            _listener.RunResumed(reason);
        }

        private void Leave(string reason)
        {
            if (!InRun) return;
            if (InGame)
            {
                InGame = false;
                _listener.GameEnded();
            }
            InRun = false;
            _listener.RunLeft(reason);
        }

        private void UpdateGame(RunPhase phase)
        {
            if (phase == RunPhase.Game)
            {
                if (InGame) return;
                InGame = true;
                _listener.GameStarted();
                return;
            }
            if (InGame)
            {
                InGame = false;
                _listener.GameEnded();
            }
            if (phase == RunPhase.Shop) _listener.ShopOpened();
        }
    }
}
