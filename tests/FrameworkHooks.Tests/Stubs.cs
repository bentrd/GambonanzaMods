// Stand-ins for Unity and unrelated UI services. The hook context, registry and
// host are the actual production sources, compiled by this test project.
using Gambonanza.ModSdk;

namespace UnityEngine
{
    public class MonoBehaviour { }
    public static class Debug
    {
        public static readonly List<string> Lines = new();
        public static bool ThrowOnLog;
        public static void Log(object message)
        {
            if (ThrowOnLog) throw new InvalidOperationException("log unavailable");
            Lines.Add(message.ToString());
        }
    }
    public static class Application { public static string dataPath => null; }
    public static class JsonUtility
    {
        public static T FromJson<T>(string json) => default;
        public static string ToJson(object value, bool prettyPrint) => "{}";
    }
}

namespace Gambonanza.ModHost
{
    internal sealed class ModConsole : IConsoleApi
    {
        public static ModConsole Instance { get; } = new();
        public static ModConsole Ensure() => Instance;
        public bool IsOpen => false;
        public void Print(string message, ConsoleLineColor color = ConsoleLineColor.Default) { }
        public void PrintInfo(string message) { }
        public void PrintWarn(string message) { }
        public void PrintError(string message) { }
        public void RegisterCommand(string name, string help, Action<string[]> handler, ConsoleArgumentCompleter completer = null) { }
        public void UnregisterCommand(string name) { }
        public void Open() { }
        public void Close() { }
        public void Toggle() { }
    }
    internal sealed class ConsoleMenuInjector { public void InjectButton(UnityEngine.MonoBehaviour canvas) { } }
    internal static class TexturePacks { public static void Load(string directory, ModConsole console) { } }
    internal static class ModUpdater
    {
        public const string FrameworkVersion = "test";
        public static void SpawnOnce(ModConsole console) { }
    }
    internal static class ModKeybinds
    {
        public const string Unset = "unset";
        public static bool IsUnset(string key) => string.IsNullOrWhiteSpace(key) || key == Unset;
        public static bool IsHeld(string key) => false;
        public static bool WasPressed(string key) => false;
    }
}
