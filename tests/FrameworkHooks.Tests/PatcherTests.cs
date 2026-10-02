using System.Diagnostics;
using System.Reflection;
using System.Runtime.Loader;
using Mono.Cecil;
using Mono.Cecil.Cil;
using Attributes = Mono.Cecil.TypeAttributes;
using Methods = Mono.Cecil.MethodAttributes;
using Fields = Mono.Cecil.FieldAttributes;

internal static class PatcherTests
{
    public static void Veto()
    {
        using var fixture = new Fixture(); fixture.Patch();
        var result = fixture.Execute(cancel: true);
        Program.Equal("hook;", result.trace, "veto ran vanilla effects");
        Program.Equal(0, result.effects, "veto mutated loss state");
        Program.Equal(1, result.hookCalls, "hook not called once");
        Program.Assert(result.sameManager, "injected hook did not receive this");
    }
    public static void Allow()
    {
        using var fixture = new Fixture(); fixture.Patch();
        var result = fixture.Execute(cancel: false);
        Program.Equal("hook;statistics;lose-state;erase-save;result-screen;", result.trace, "hook was late or original order changed");
        Program.Equal(4, result.effects, "vanilla effects skipped");
        Program.Equal(1, result.hookCalls, "hook not called once");
    }
    public static void Idempotent()
    {
        using var fixture = new Fixture(); fixture.Patch();
        var original = File.ReadAllBytes(fixture.GamePath + ".orig");
        fixture.Patch();
        Program.Assert(original.SequenceEqual(File.ReadAllBytes(fixture.GamePath + ".orig")), "repatch replaced clean backup");
        using var game = AssemblyDefinition.ReadAssembly(fixture.GamePath);
        var lose = game.MainModule.GetType("Blukulele.Core.GameManager").Methods.Single(m => m.Name == "Lose");
        Program.Equal(1, lose.Body.Instructions.Count(i => i.Operand is MethodReference method && method.Name == "ShouldCancelLoss"), "duplicate injected loss hook");
        var result = fixture.Execute(cancel: false);
        Program.Equal(1, result.hookCalls, "repatch executed multiple hooks");
        Program.Equal(4, result.effects, "repatch corrupted original body");
    }
    public static void MissingLose()
    {
        foreach (var shape in new[] { LossShape.Missing, LossShape.Static, LossShape.Parameter, LossShape.NonVoid })
        {
            using var fixture = new Fixture(shape);
            var original = File.ReadAllBytes(fixture.GamePath);
            var result = fixture.RunPatcher();
            Program.Equal(3, result.code, "incompatible loss target should abort: " + shape);
            Program.Assert(result.output.Contains("defeat hook required"), "missing-target diagnostic absent");
            Program.Assert(original.SequenceEqual(File.ReadAllBytes(fixture.GamePath)), "failed patch changed game assembly");
            Program.Assert(!File.Exists(fixture.GamePath + ".orig.stamp"), "failed patch stamped an unpatched assembly");
        }
    }

    private enum LossShape { Normal, Missing, Static, Parameter, NonVoid }
    // All fixture assemblies are generated here. No Unity or game DLLs are needed.
    private sealed class Fixture : IDisposable
    {
        private readonly string root = Path.Combine(Path.GetTempPath(), "gambonanza-hook-tests-" + Guid.NewGuid().ToString("N"));
        private readonly string sources;
        private readonly string managed;
        public string GamePath => Path.Combine(managed, "Assembly-CSharp.dll");
        public Fixture(LossShape shape = LossShape.Normal)
        {
            sources = Path.Combine(root, "sources"); managed = Path.Combine(root, "Managed");
            Directory.CreateDirectory(sources); Directory.CreateDirectory(managed);
            using var unity = NewAssembly("UnityEngine.CoreModule");
            var u = unity.MainModule;
            var behaviour = NewClass(u, "UnityEngine", "MonoBehaviour");
            var audioClip = NewClass(u, "UnityEngine", "AudioClip");
            var state = NewClass(u, "UnityEngine", "TestState");
            var trace = new FieldDefinition("Trace", Fields.Public | Fields.Static, u.TypeSystem.String); state.Fields.Add(trace);
            var record = Method(state, "Record", u.TypeSystem.Void, isStatic: true, u.TypeSystem.String);
            Emit(record, Instruction.Create(OpCodes.Ldsfld, trace), Instruction.Create(OpCodes.Ldarg_0),
                Instruction.Create(OpCodes.Call, u.ImportReference(typeof(string).GetMethod("Concat", new[] { typeof(string), typeof(string) }))),
                Instruction.Create(OpCodes.Stsfld, trace), Instruction.Create(OpCodes.Ret));
            unity.Write(Path.Combine(managed, "UnityEngine.CoreModule.dll"));

            using var sdk = NewAssembly("Gambonanza.ModSdk"); sdk.Write(Path.Combine(sources, "Gambonanza.ModSdk.dll"));
            using var host = NewAssembly("Gambonanza.ModHost");
            var h = host.MainModule; var hostType = NewClass(h, "Gambonanza.ModHost", "ModHost");
            var cancel = new FieldDefinition("CancelLoss", Fields.Public | Fields.Static, h.TypeSystem.Boolean); hostType.Fields.Add(cancel);
            var calls = new FieldDefinition("HookCalls", Fields.Public | Fields.Static, h.TypeSystem.Int32); hostType.Fields.Add(calls);
            var last = new FieldDefinition("LastManager", Fields.Public | Fields.Static, h.ImportReference(behaviour)); hostType.Fields.Add(last);
            var shouldCancel = Method(hostType, "ShouldCancelLoss", h.TypeSystem.Boolean, true, h.ImportReference(behaviour));
            Emit(shouldCancel, Instruction.Create(OpCodes.Ldarg_0), Instruction.Create(OpCodes.Stsfld, last),
                Instruction.Create(OpCodes.Ldsfld, calls), Instruction.Create(OpCodes.Ldc_I4_1), Instruction.Create(OpCodes.Add), Instruction.Create(OpCodes.Stsfld, calls),
                Instruction.Create(OpCodes.Ldstr, "hook;"), Instruction.Create(OpCodes.Call, h.ImportReference(record)),
                Instruction.Create(OpCodes.Ldsfld, cancel), Instruction.Create(OpCodes.Ret));
            Emit(Method(hostType, "LoadAll", h.TypeSystem.Void, true), Instruction.Create(OpCodes.Ret));
            var audioHost = NewClass(h, "Gambonanza.ModHost", "ResourcePackAudio");
            Emit(Method(audioHost, "Resolve", h.ImportReference(audioClip), true, h.ImportReference(audioClip)), Instruction.Create(OpCodes.Ldarg_0), Instruction.Create(OpCodes.Ret));
            host.Write(Path.Combine(sources, "Gambonanza.ModHost.dll"));

            using var game = NewAssembly("Assembly-CSharp"); var g = game.MainModule;
            var manager = NewClass(g, "Blukulele.Core", "GameManager", g.ImportReference(behaviour));
            Emit(Method(manager, "Start", g.TypeSystem.Void), Instruction.Create(OpCodes.Ret));
            var effects = new FieldDefinition("LossEffects", Fields.Public, g.TypeSystem.Int32); manager.Fields.Add(effects);
            if (shape != LossShape.Missing)
            {
                var lose = Method(manager, "Lose", shape == LossShape.NonVoid ? g.TypeSystem.Boolean : g.TypeSystem.Void,
                    shape == LossShape.Static, shape == LossShape.Parameter ? new[] { g.TypeSystem.Int32 } : Array.Empty<TypeReference>());
                if (shape == LossShape.Normal)
                    foreach (var effect in new[] { "statistics;", "lose-state;", "erase-save;", "result-screen;" })
                        Emit(lose, Instruction.Create(OpCodes.Ldarg_0), Instruction.Create(OpCodes.Dup), Instruction.Create(OpCodes.Ldfld, effects),
                            Instruction.Create(OpCodes.Ldc_I4_1), Instruction.Create(OpCodes.Add), Instruction.Create(OpCodes.Stfld, effects),
                            Instruction.Create(OpCodes.Ldstr, effect), Instruction.Create(OpCodes.Call, g.ImportReference(record)));
                if (shape == LossShape.NonVoid) Emit(lose, Instruction.Create(OpCodes.Ldc_I4_0));
                Emit(lose, Instruction.Create(OpCodes.Ret));
            }
            var audio = NewClass(g, "Blukulele.Module.Audio", "AudioManager");
            Emit(Method(audio, "ChooseRandomClip", g.ImportReference(audioClip)), Instruction.Create(OpCodes.Ldnull), Instruction.Create(OpCodes.Ret));
            game.Write(GamePath);
        }
        public (int code, string output) RunPatcher()
        {
            var start = new ProcessStartInfo("dotnet") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
            start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "patcher", "GambonanzaPatcher.dll"));
            start.ArgumentList.Add(managed); start.ArgumentList.Add(Path.Combine(sources, "Gambonanza.ModSdk.dll"));
            start.ArgumentList.Add(Path.Combine(sources, "Gambonanza.ModHost.dll"));
            using var process = Process.Start(start);
            var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(30000)) { process.Kill(entireProcessTree: true); throw new Exception("patcher timed out"); }
            return (process.ExitCode, stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult());
        }
        public void Patch()
        {
            var result = RunPatcher(); Program.Equal(0, result.code, "patcher failed:\n" + result.output);
        }
        public (string trace, int effects, int hookCalls, bool sameManager) Execute(bool cancel)
        {
            var loader = new AssemblyLoadContext("fixture", isCollectible: true);
            loader.Resolving += (_, name) => File.Exists(Path.Combine(managed, name.Name + ".dll"))
                ? loader.LoadFromAssemblyPath(Path.Combine(managed, name.Name + ".dll")) : null;
            try
            {
                var host = loader.LoadFromAssemblyPath(Path.Combine(managed, "Gambonanza.ModHost.dll")).GetType("Gambonanza.ModHost.ModHost");
                host.GetField("CancelLoss").SetValue(null, cancel);
                var game = loader.LoadFromAssemblyPath(GamePath).GetType("Blukulele.Core.GameManager");
                var manager = Activator.CreateInstance(game); game.GetMethod("Lose").Invoke(manager, null);
                var state = loader.LoadFromAssemblyPath(Path.Combine(managed, "UnityEngine.CoreModule.dll")).GetType("UnityEngine.TestState");
                return ((string)state.GetField("Trace").GetValue(null), (int)game.GetField("LossEffects").GetValue(manager),
                    (int)host.GetField("HookCalls").GetValue(null), ReferenceEquals(manager, host.GetField("LastManager").GetValue(null)));
            }
            finally { loader.Unload(); }
        }
        public void Dispose() => Directory.Delete(root, recursive: true);
        private static AssemblyDefinition NewAssembly(string name)
            => AssemblyDefinition.CreateAssembly(new AssemblyNameDefinition(name, new Version(0, 1, 0, 0)), name, ModuleKind.Dll);
        private static TypeDefinition NewClass(ModuleDefinition module, string ns, string name, TypeReference parent = null)
        {
            var type = new TypeDefinition(ns, name, Attributes.Public | Attributes.Class, parent ?? module.ImportReference(typeof(object))); module.Types.Add(type);
            var ctor = new MethodDefinition(".ctor", Methods.Public | Methods.SpecialName | Methods.RTSpecialName, module.TypeSystem.Void); type.Methods.Add(ctor);
            var baseCtor = parent == null ? module.ImportReference(typeof(object).GetConstructor(Type.EmptyTypes))
                : new MethodReference(".ctor", module.TypeSystem.Void, parent) { HasThis = true };
            Emit(ctor, Instruction.Create(OpCodes.Ldarg_0), Instruction.Create(OpCodes.Call, baseCtor), Instruction.Create(OpCodes.Ret));
            return type;
        }
        private static MethodDefinition Method(TypeDefinition type, string name, TypeReference result, bool isStatic = false, params TypeReference[] args)
        {
            var method = new MethodDefinition(name, Methods.Public | (isStatic ? Methods.Static : 0), result); type.Methods.Add(method);
            foreach (var arg in args) method.Parameters.Add(new ParameterDefinition(arg));
            return method;
        }
        private static void Emit(MethodDefinition method, params Instruction[] instructions)
        {
            foreach (var instruction in instructions) method.Body.Instructions.Add(instruction);
        }
    }
}
