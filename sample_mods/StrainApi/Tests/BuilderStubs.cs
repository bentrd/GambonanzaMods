// Metadata-only contracts require no game runtime. These stubs keep the real
// builder and definition source in the test project without Unity assemblies.
namespace UnityEngine
{
    public sealed class Sprite { }
    public static class Mathf
    {
        public static int Clamp(int value, int min, int max)
            => System.Math.Max(min, System.Math.Min(max, value));
    }
}

namespace Gambonanza.StrainApi
{
    public abstract class StrainBehaviour { }
    internal enum StrainEvent { Activated, RunStarted, GameStarted, PlayerTurn, GameEnded, ShopOpened, Deactivated }
    public static class Strains
    {
        public const int MaxIdLength = 40;
        public const int MaxHeat = 9;
    }
    internal static class StrainRegistry
    {
        internal static bool Register(StrainDefinition definition) => true;
    }
}
