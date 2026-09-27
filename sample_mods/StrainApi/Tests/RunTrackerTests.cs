using System.Collections.Generic;
using NUnit.Framework;

namespace Gambonanza.StrainApi.Tests
{
    /// <summary>
    /// RunTracker against the state sequences the game really produces. The sequences
    /// come from mods that follow the same states (Coop, ImpatientGambit, CrumbleApi):
    /// a run opens on the piece wheel, every game goes BOARD_PLACEMENT -> INGAME ->
    /// WIN -> RESULT -> SHOP, pause/settings/promotion re-enter INGAME, quitting goes
    /// PAUSE -> MENU, and Continue goes LOAD_RUN -> whatever state was saved.
    /// </summary>
    public sealed class RunTrackerTests
    {
        private sealed class Recorder : IRunListener
        {
            public readonly List<string> Events = new List<string>();
            public void RunStarted() => Events.Add("RunStarted");
            public void RunResumed(string reason) => Events.Add("RunResumed");
            public void RunLeft(string reason) => Events.Add("RunLeft");
            public void GameStarted() => Events.Add("GameStarted");
            public void GameEnded() => Events.Add("GameEnded");
            public void ShopOpened() => Events.Add("ShopOpened");
        }

        private Recorder _events;
        private RunTracker _tracker;

        [SetUp]
        public void SetUp()
        {
            _events = new Recorder();
            _tracker = new RunTracker(_events);
            _tracker.CatchUp(RunPhase.Menu, -1);          // the game boots to its menu
        }

        private void Go(RunPhase phase, int wave = -1, bool fromLoading = false)
            => _tracker.OnPhase(phase, fromLoading, wave);

        /// <summary>One whole game and its aftermath, the way the game sequences it.</summary>
        private void PlayGame(int wave)
        {
            Go(RunPhase.Opening, wave);     // BOARD_PLACEMENT
            Go(RunPhase.Game, wave);        // INGAME
            Go(RunPhase.Between, wave);     // WIN
            Go(RunPhase.Between, wave);     // RESULT
            Go(RunPhase.Shop, wave);        // SHOP
        }

        [Test]
        public void ANewRunStartsOnItsFirstRunStateAndReportsEachGame()
        {
            Go(RunPhase.Opening, 0);        // PIECE_SELECTION, the run-start wheel
            PlayGame(0);
            PlayGame(1);

            Assert.That(_events.Events, Is.EqualTo(new[]
            {
                "RunStarted",
                "GameStarted", "GameEnded", "ShopOpened",
                "GameStarted", "GameEnded", "ShopOpened",
            }));
            Assert.That(_tracker.InRun, Is.True);
            Assert.That(_tracker.InGame, Is.False);
        }

        [Test]
        public void PauseSettingsAndPromotionDoNotRestartTheGame()
        {
            Go(RunPhase.Opening, 0);
            Go(RunPhase.Game, 0);
            Go(RunPhase.Other);             // PAUSE
            Go(RunPhase.Game, 0);           // back to INGAME
            Go(RunPhase.Other);             // PROMOTION
            Go(RunPhase.Game, 0);
            Go(RunPhase.Other);             // RUN_INFO
            Go(RunPhase.Game, 0);

            Assert.That(_events.Events, Is.EqualTo(new[] { "RunStarted", "GameStarted" }));
            Assert.That(_tracker.InGame, Is.True);
        }

        [Test]
        public void QuittingToTheMenuEndsTheGameThenLeavesTheRun()
        {
            Go(RunPhase.Opening, 0);
            Go(RunPhase.Game, 0);
            Go(RunPhase.Other);             // PAUSE
            Go(RunPhase.Menu);              // Main Menu

            Assert.That(_events.Events, Is.EqualTo(new[] { "RunStarted", "GameStarted", "GameEnded", "RunLeft" }));
            Assert.That(_tracker.InRun, Is.False);
            Assert.That(_tracker.InGame, Is.False);
        }

        [Test]
        public void LosingEndsTheGameAndTheMenuEndsTheRun()
        {
            Go(RunPhase.Opening, 0);
            Go(RunPhase.Game, 0);
            Go(RunPhase.Between, 0);        // LOSE
            Go(RunPhase.Menu);

            Assert.That(_events.Events, Is.EqualTo(new[] { "RunStarted", "GameStarted", "GameEnded", "RunLeft" }));
        }

        [Test]
        public void ContinuingIntoAGameResumesWithoutStartingAnything()
        {
            Go(RunPhase.Loading);                               // LOAD_RUN
            Go(RunPhase.Game, 3, fromLoading: true);            // the saved game

            Assert.That(_events.Events, Is.EqualTo(new[] { "RunResumed" }));
            Assert.That(_tracker.InGame, Is.True, "the game resumed into is on, so its end is still reported");

            Go(RunPhase.Between, 3);        // WIN
            Assert.That(_events.Events, Is.EqualTo(new[] { "RunResumed", "GameEnded" }));
        }

        [Test]
        public void ContinuingIntoTheShopDoesNotReportTheShopOpening()
        {
            Go(RunPhase.Loading);
            Go(RunPhase.Shop, 3, fromLoading: true);
            PlayGame(4);

            Assert.That(_events.Events, Is.EqualTo(new[]
            {
                "RunResumed",
                "GameStarted", "GameEnded", "ShopOpened",
            }));
        }

        [Test]
        public void ContinueIsRecognisedEvenWithAStateInBetween()
        {
            // PreviousState only remembers one step; the tracker remembers LOAD_RUN itself.
            Go(RunPhase.Loading);
            Go(RunPhase.Other);
            Go(RunPhase.Opening, 3, fromLoading: false);

            Assert.That(_events.Events, Is.EqualTo(new[] { "RunResumed" }));
        }

        [Test]
        public void BackingOutOfAContinueToTheMenuForgetsIt()
        {
            Go(RunPhase.Loading);
            Go(RunPhase.Menu);
            Go(RunPhase.Opening, 0);

            Assert.That(_events.Events, Is.EqualTo(new[] { "RunStarted" }));
        }

        [Test]
        public void ContinuingWhileARunIsStillMarkedLiveLeavesItFirst()
        {
            Go(RunPhase.Opening, 0);
            Go(RunPhase.Game, 0);
            Go(RunPhase.Loading);           // the menu signal was missed somehow
            Go(RunPhase.Game, 0, fromLoading: true);

            Assert.That(_events.Events, Is.EqualTo(new[]
            {
                "RunStarted", "GameStarted", "GameEnded", "RunLeft", "RunResumed",
            }));
        }

        [Test]
        public void TheWaveCountGoingBackwardsMeansANewRun()
        {
            Go(RunPhase.Opening, 0);
            PlayGame(0);
            PlayGame(7);
            _events.Events.Clear();

            Go(RunPhase.Opening, 0);        // a new run's wheel, without the menu in between

            Assert.That(_events.Events, Is.EqualTo(new[] { "RunLeft", "RunStarted" }));
        }

        [Test]
        public void AnUnknownWaveNeverLooksLikeANewRun()
        {
            Go(RunPhase.Opening, 5);
            Go(RunPhase.Opening, -1);
            Go(RunPhase.Opening, 5);

            Assert.That(_events.Events, Is.EqualTo(new[] { "RunStarted" }));
        }

        [Test]
        public void ComingOnlineMidGameResumesTheRunInThatGame()
        {
            var tracker = new RunTracker(_events);
            tracker.CatchUp(RunPhase.Game, 2);

            Assert.That(_events.Events, Is.EqualTo(new[] { "RunResumed" }));
            Assert.That(tracker.InRun, Is.True);
            Assert.That(tracker.InGame, Is.True);
        }

        [Test]
        public void ComingOnlineInTheMenuOrAPauseDoesNothing()
        {
            var tracker = new RunTracker(_events);
            tracker.CatchUp(RunPhase.Menu, -1);
            tracker.CatchUp(RunPhase.Other, -1);

            Assert.That(_events.Events, Is.Empty);
            Assert.That(tracker.InRun, Is.False);
        }

        [Test]
        public void ComingOnlineWhileASaveLoadsResumesOnTheNextRunState()
        {
            var tracker = new RunTracker(_events);
            tracker.CatchUp(RunPhase.Loading, -1);
            tracker.OnPhase(RunPhase.Shop, previousWasLoading: false, wave: 4);

            Assert.That(_events.Events, Is.EqualTo(new[] { "RunResumed" }));
        }

        [Test]
        public void ResetForgetsTheRunWithoutReportingAnything()
        {
            Go(RunPhase.Opening, 0);
            Go(RunPhase.Game, 0);
            _events.Events.Clear();

            _tracker.Reset();
            Assert.That(_tracker.InRun, Is.False);
            Assert.That(_tracker.InGame, Is.False);
            Assert.That(_events.Events, Is.Empty);

            _tracker.CatchUp(RunPhase.Game, 0);   // re-enabled mid-game
            Assert.That(_events.Events, Is.EqualTo(new[] { "RunResumed" }));
        }

        [Test]
        public void TheMenuOutsideARunReportsNothing()
        {
            Go(RunPhase.Menu);
            Go(RunPhase.Other);             // COLLECTION, SETTINGS
            Go(RunPhase.Menu);

            Assert.That(_events.Events, Is.Empty);
        }
    }
}
