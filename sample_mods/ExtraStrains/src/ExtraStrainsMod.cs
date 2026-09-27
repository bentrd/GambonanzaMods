using Blukulele.CHE;
using Blukulele.Core;
using Gambonanza.ModSdk;
using Gambonanza.StrainApi;

namespace Gambonanza.ExtraStrains
{
    /// <summary>
    /// Mod entry point: registers two strains with the Strain Creation API.
    ///
    /// A strain needs nothing from the game to be registered, so registration lives in
    /// OnEnable and is undone in OnDisable - which is all it takes for the mod to support
    /// being switched on and off mid-session (`mods disable ExtraStrains`). A strain that
    /// is on the run being played is put away cleanly when it is unregistered.
    ///
    /// The two strains show the two ways to write one:
    ///   taxman     - builder delegates only: stateless, a few lines, right here.
    ///   short-fuse - a StrainBehaviour subclass (ShortFuseStrain.cs) that keeps per-game
    ///                state and builds on another library mod, CrumbleApi.
    /// </summary>
    public sealed class ExtraStrainsMod : IMod, IModLifecycle
    {
        public const string TaxmanId = "taxman";

        private IModContext _ctx;

        public void OnLoad(IModContext context) => _ctx = context;

        public void OnEnable()
        {
            // Ids are permanent: the player's picks and their saved run refer to them.
            StrainBuilder.Create(TaxmanId)
                .WithName("Taxman")
                // Descriptions use the game's own markup; <color=*> is its money colour.
                .WithDescription("Every game costs <color=*>$1</color> to start.")
                // Once per game: a run continued in the middle of a game is not charged again.
                .OnGameStart(_ => PayTheTaxman())
                .Register();

            StrainBuilder.Create(ShortFuseStrain.StrainId)
                .WithName("Short Fuse")
                .WithDescription($"Every game, the <shake>Crumble</shake> countdown starts {ShortFuseStrain.TurnsSooner} turns in.")
                .WithBehaviour<ShortFuseStrain>()
                .Register();

            _ctx?.LogLine("strains registered - pick them from MOD STRAINS on the home screen, or 'strain on taxman' in the console.");
        }

        public void OnDisable()
        {
            Strains.Unregister(TaxmanId);
            Strains.Unregister(ShortFuseStrain.StrainId);
        }

        /// <summary>
        /// Takes $1 if the player has it. ChessDataManager holds the run's money, and
        /// DecreaseCoin is how the game itself spends it.
        /// </summary>
        private static void PayTheTaxman()
        {
            if (!SingletonMonoBehaviour<ChessDataManager>.IsCreated()) return;
            var chess = SingletonMonoBehaviour<ChessDataManager>.Instance;
            if (!chess || chess.Coins < 1) return;
            chess.DecreaseCoin(1);
        }
    }
}
