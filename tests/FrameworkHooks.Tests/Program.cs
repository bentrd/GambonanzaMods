using System.Reflection;
using Gambonanza.ModHost;
using Gambonanza.ModSdk;
using UnityEngine;
using Host = Gambonanza.ModHost.ModHost;

internal static class Program
{
    private static int Main()
    {
        var tests = new (string, Action)[]
        {
            ("context: no handlers and unsubscribe allow loss", ContextDefaults),
            ("context: first rescue wins and receives the manager", ContextFirstWins),
            ("context: exceptions allow later handlers", ContextExceptions),
            ("registry: enabled mods in order, first rescue wins", RegistryRouting),
            ("registry: additions during callback wait for next attempt", RegistrySnapshot),
            ("host: absent registry and null manager allow loss", HostDefaults),
            ("host: same-manager recursion suppressed, later calls dispatch", HostSameManagerRecursion),
            ("host: distinct managers dispatch, despite custom equality", HostDifferentManagers),
            ("host: throwing handlers and failed logging do not strand guard", HostGuardCleanup),
            ("host: dispatch failure falls open and releases guard", HostDispatchFailure),
            ("SDK: existing IModContext implementations remain valid", OptionalCapability),
            ("patcher: executed veto skips all loss effects", PatcherTests.Veto),
            ("patcher: executed false preserves loss order", PatcherTests.Allow),
            ("patcher: reinstall keeps a single loss hook", PatcherTests.Idempotent),
            ("patcher: missing or incompatible Lose aborts unchanged", PatcherTests.MissingLose),
        };
        var failed = 0;
        foreach (var (name, test) in tests)
        {
            try { ResetHost(); test(); Console.WriteLine("PASS " + name); }
            catch (Exception ex) { failed++; Console.Error.WriteLine("FAIL " + name + "\n" + ex); }
            finally { Debug.ThrowOnLog = false; }
        }
        Console.WriteLine($"{tests.Length - failed}/{tests.Length} passed");
        return failed == 0 ? 0 : 1;
    }

    internal static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
    internal static void Equal<T>(T expected, T actual, string message)
        => Assert(EqualityComparer<T>.Default.Equals(expected, actual), $"{message}: expected {expected}, got {actual}");
    private static ModContext Context(string id = "test") => new(id, "/unused", ModConsole.Instance);
    private static void ResetHost()
    {
        SetRegistry(null);
        Debug.Lines.Clear();
    }
    private static void SetRegistry(ModRegistry registry)
        => typeof(Host).GetField("_registry", BindingFlags.Static | BindingFlags.NonPublic).SetValue(null, registry);
    private static ModRegistry Registry(params (ModContext context, bool active)[] mods)
    {
        var registry = new ModRegistry();
        var list = (List<ModRegistry.LoadedMod>)typeof(ModRegistry).GetField("_mods", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(registry);
        foreach (var (context, active) in mods)
            list.Add(new ModRegistry.LoadedMod { Context = context, IsActive = active });
        return registry;
    }
    private static void ContextDefaults()
    {
        var ctx = Context();
        var gm = new MonoBehaviour();
        Assert(!ctx.RaiseBeforeLose(gm), "empty event must allow vanilla");
        Func<MonoBehaviour, bool> rescue = _ => true;
        ctx.OnBeforeLose += rescue;
        Assert(ctx.RaiseBeforeLose(gm), "subscription must cancel");
        ctx.OnBeforeLose -= rescue;
        Assert(!ctx.RaiseBeforeLose(gm), "unsubscribed handler must not run");
    }
    private static void ContextFirstWins()
    {
        var ctx = Context();
        var gm = new MonoBehaviour();
        var calls = "";
        ctx.OnBeforeLose += manager => { Assert(ReferenceEquals(gm, manager), "wrong manager"); calls += "a"; return false; };
        ctx.OnBeforeLose += _ => { calls += "b"; return true; };
        ctx.OnBeforeLose += _ => { calls += "c"; return true; };
        Assert(ctx.RaiseBeforeLose(gm), "rescue not claimed");
        Equal("ab", calls, "multiple handlers consumed rescues");
    }
    private static void ContextExceptions()
    {
        var ctx = Context("broken-mod");
        ctx.OnBeforeLose += _ => throw new InvalidOperationException("bad rescue");
        ctx.OnBeforeLose += _ => true;
        Assert(ctx.RaiseBeforeLose(new MonoBehaviour()), "later rescue skipped after exception");
        Assert(Debug.Lines.Any(line => line.Contains("[broken-mod]") && line.Contains("bad rescue")), "handler failure not logged with mod identity");
    }
    private static void RegistryRouting()
    {
        var calls = "";
        var inactive = Context(); inactive.OnBeforeLose += _ => { calls += "inactive"; return true; };
        var decline = Context(); decline.OnBeforeLose += _ => { calls += "a"; return false; };
        var rescue = Context(); rescue.OnBeforeLose += _ => { calls += "b"; return true; };
        var second = Context(); second.OnBeforeLose += _ => { calls += "c"; return true; };
        var registry = Registry((null, false), (inactive, false), (decline, true), (rescue, true), (second, true));
        Assert(registry.DispatchBeforeLose(new MonoBehaviour()), "enabled rescue missing");
        Equal("ab", calls, "disabled mods or later rescue ran");
    }
    private static void HostDefaults()
    {
        Assert(!Host.ShouldCancelLoss(new MonoBehaviour()), "uninitialized host must allow loss");
        var ctx = Context(); ctx.OnBeforeLose += _ => true; SetRegistry(Registry((ctx, true)));
        Assert(!Host.ShouldCancelLoss(null), "null manager should not dispatch");
    }
    private static void RegistrySnapshot()
    {
        var calls = ""; var first = Context(); var second = Context(); var added = Context();
        added.OnBeforeLose += _ => { calls += "new"; return true; };
        second.OnBeforeLose += _ => { calls += "b"; return false; };
        var registry = Registry((first, true), (second, true));
        var changed = false;
        first.OnBeforeLose += _ =>
        {
            calls += "a";
            if (!changed)
            {
                changed = true;
                var list = (List<ModRegistry.LoadedMod>)typeof(ModRegistry).GetField("_mods", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(registry);
                list.Insert(1, new ModRegistry.LoadedMod { Context = added, IsActive = true });
            }
            return false;
        };
        Assert(!registry.DispatchBeforeLose(new MonoBehaviour()), "new mod ran midway through loss dispatch");
        Equal("ab", calls, "existing mod order changed during dispatch");
        Assert(registry.DispatchBeforeLose(new MonoBehaviour()), "new mod missing on next attempt");
        Equal("abanew", calls, "next attempt did not use updated order");
    }
    private static void HostSameManagerRecursion()
    {
        var ctx = Context(); var gm = new MonoBehaviour(); var calls = 0;
        ctx.OnBeforeLose += manager => { calls++; Assert(Host.ShouldCancelLoss(manager), "nested vanilla loss permitted"); return false; };
        SetRegistry(Registry((ctx, true)));
        Assert(!Host.ShouldCancelLoss(gm), "outer decline should allow vanilla");
        Assert(!Host.ShouldCancelLoss(gm), "future calls should dispatch again");
        Equal(2, calls, "recursion or retained dispatch guard");
    }
    private sealed class EqualManager : MonoBehaviour
    {
        public override bool Equals(object other) => other is EqualManager;
        public override int GetHashCode() => 1;
    }
    private static void HostDifferentManagers()
    {
        var first = new EqualManager(); var second = new EqualManager(); var calls = 0; var ctx = Context();
        ctx.OnBeforeLose += manager =>
        {
            calls++;
            if (ReferenceEquals(manager, first)) Assert(!Host.ShouldCancelLoss(second), "distinct manager suppressed");
            return false;
        };
        SetRegistry(Registry((ctx, true)));
        Assert(!Host.ShouldCancelLoss(first), "outer decline should allow loss");
        Equal(2, calls, "guard must use reference identity");
    }
    private static void HostGuardCleanup()
    {
        var ctx = Context(); var gm = new MonoBehaviour(); var calls = 0;
        ctx.OnBeforeLose += _ => { calls++; throw new Exception("boom"); };
        SetRegistry(Registry((ctx, true))); Debug.ThrowOnLog = true;
        Assert(!Host.ShouldCancelLoss(gm), "throwing handler should allow vanilla");
        Assert(!Host.ShouldCancelLoss(gm), "guard left after failure");
        Equal(2, calls, "subsequent dispatch missing");
    }
    private static void HostDispatchFailure()
    {
        var gm = new MonoBehaviour(); var broken = new ModRegistry();
        // Fault injection outside handler invocation exercises the host's catch.
        var list = (List<ModRegistry.LoadedMod>)typeof(ModRegistry).GetField("_mods", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(broken);
        list.Add(null); SetRegistry(broken);
        Assert(!Host.ShouldCancelLoss(gm), "dispatcher failure must allow vanilla loss");
        Assert(Debug.Lines.Any(line => line.Contains("ShouldCancelLoss failed")), "dispatcher failure not logged");
        var calls = 0; var healthy = Context();
        healthy.OnBeforeLose += _ => { calls++; return false; };
        SetRegistry(Registry((healthy, true)));
        Assert(!Host.ShouldCancelLoss(gm), "failed dispatch retained guard");
        Equal(1, calls, "healthy registry not reached after failure");
    }
    // Deliberately uses only the original context contract. This compilation is
    // a compatibility check against accidentally adding the event to IModContext.
    private sealed class LegacyContext : IModContext
    {
        public string ModId => "legacy";
        public string ModDirectory => "/unused";
        public IConsoleApi Console => null;
        public event Action<MonoBehaviour> OnSettingsOpened { add { } remove { } }
        public void LogLine(string message) { }
        public bool IsKeybindHeld(string name) => false;
        public bool WasKeybindPressed(string name) => false;
        public string GetKeybind(string name) => "unset";
    }
    private static void OptionalCapability()
    {
        Assert(Context() is IModLossHooks, "host context missing capability");
        Assert((IModContext)new LegacyContext() is not IModLossHooks, "legacy context should not require new capability");
    }
}
