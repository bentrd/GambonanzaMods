using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using Mono.Cecil;
using Mono.Cecil.Cil;

namespace Gambonanza.Patcher;

/// <summary>
/// Generic Cecil patcher. Injects three calls into Assembly-CSharp.dll:
///   1. Gambonanza.ModHost.ModHost.LoadAll()                       at GameManager.Start
///   2. Gambonanza.ModHost.ModHost.OnSettingsOpenedInvoke(this)    at SettingsCanvas.OnEnable
///   3. Gambonanza.ModHost.ModHost.OnHomeMenuOpenedInvoke(this)    at CanvasMenu.OnEnable
///
/// All mod-specific logic lives in mods loaded by ModHost at runtime - this patcher
/// has no knowledge of any individual mod.
///
/// Usage:
///   GambonanzaPatcher &lt;ManagedFolder&gt; &lt;ModSdk.dll&gt; &lt;ModHost.dll&gt; [extra-runtime-dlls...]
///
/// Any DLLs after &lt;ModHost.dll&gt; are also copied into Managed/ so they get loaded
/// by Unity at startup. Use this for runtime helper libs like Gambonanza.GameUI.dll.
/// </summary>
internal static class Program
{
    private const string ModHostAsmName  = "Gambonanza.ModHost";
    private const string ModHostTypeFull = "Gambonanza.ModHost.ModHost";
    private const string MarkerType      = "__GambonanzaModHostPatched";

    private static int Main(string[] args)
    {
        if (args.Length < 3)
        {
            Console.Error.WriteLine(
                "usage: GambonanzaPatcher <Managed-folder> <ModSdk.dll> <ModHost.dll> [extra-runtime-dlls...]");
            return 2;
        }

        var managedDir = args[0];
        var modSdkSrc  = args[1];
        var modHostSrc = args[2];
        var extraDlls  = args.Skip(3).ToArray();
        var asmCsharp  = Path.Combine(managedDir, "Assembly-CSharp.dll");
        var backup     = asmCsharp + ".orig";
        // Stamp written next to .orig after each successful patch. Stores the SHA256
        // of the patched .dll we just wrote. On the next run we hash the on-disk .dll
        // and compare; mismatch ⇒ someone (almost certainly Steam, via a game update
        // or "verify integrity") has replaced our patched output, so .orig is now
        // stale and must be refreshed before we patch again.
        var stamp      = backup + ".stamp";

        if (!File.Exists(asmCsharp))
        {
            Console.Error.WriteLine($"Assembly-CSharp.dll not found at {asmCsharp}");
            return 1;
        }
        foreach (var src in (new[] { modSdkSrc, modHostSrc }).Concat(extraDlls))
        {
            if (!File.Exists(src))
            {
                Console.Error.WriteLine($"required dll missing: {src}");
                return 1;
            }
        }

        // 1. Maintain the .orig backup. We treat the on-disk .dll as authoritative
        //    "current vanilla" whenever we can prove it's NOT our patched output.
        //    Two independent signals; either one triggers a refresh:
        //
        //      a) No marker type in the .dll → it's vanilla (first install OR Steam
        //         just re-shipped vanilla via an update / verify-integrity).
        //      b) The .dll's hash differs from the .stamp we wrote after the last
        //         patch → something replaced our patched output. The marker may
        //         still be present (e.g. a previous run wrote a stale-patched DLL),
        //         but the bytes don't match what we last produced, so we cannot
        //         trust .orig either. Fall back to using the current .dll IF it
        //         lacks the marker; otherwise we have no clean vanilla to recover
        //         from and must ask the user to Steam-verify.
        //
        //    Patching from a stale .orig is the failure mode that produced the
        //    "GambitExplanation: Read 92 bytes but expected 120 bytes" crash after a
        //    game update - Unity's serialized assets reference vanilla types whose
        //    field layouts changed between game versions.
        bool dllHasMarker = HasMarker(asmCsharp);
        bool dllMatchesStamp = StampMatches(stamp, asmCsharp);

        if (!File.Exists(backup))
        {
            if (dllHasMarker)
            {
                Console.Error.WriteLine($"  error: no .orig backup and on-disk dll is patched. Steam-verify the game (or restore vanilla {Path.GetFileName(asmCsharp)}) and re-run.");
                return 4;
            }
            File.Copy(asmCsharp, backup);
            Console.WriteLine($"  backup -> {Path.GetFileName(backup)} (initial)");
        }
        else if (!dllHasMarker)
        {
            File.Copy(asmCsharp, backup, overwrite: true);
            Console.WriteLine($"  backup -> {Path.GetFileName(backup)} (refreshed: on-disk dll is vanilla, likely a Steam update)");
        }
        else if (!dllMatchesStamp)
        {
            // .dll is patched but doesn't match our last-written stamp. Either the
            // user manually patched with an older patcher, or something else rewrote
            // the file. We can't tell whether .orig matches the current game version,
            // so warn loudly. The patcher will proceed using the existing .orig - if
            // it turns out to be stale, the user will see the serialization-layout
            // crash and need to Steam-verify.
            Console.WriteLine($"  warn: on-disk dll does not match the post-patch stamp; .orig may be stale.");
            Console.WriteLine($"  warn: if the game crashes at startup, Steam-verify the game and re-run ./build.sh.");
        }

        // 2. Install ModSdk + ModHost (+ any extra runtime DLLs) into Managed/ so
        //    Unity loads them at startup.
        foreach (var src in (new[] { modSdkSrc, modHostSrc }).Concat(extraDlls))
        {
            var dest = Path.Combine(managedDir, Path.GetFileName(src));
            File.Copy(src, dest, overwrite: true);
            Console.WriteLine($"  install -> {Path.GetFileName(dest)}");
        }

        // 3. Always patch from the original backup. Idempotent.
        var asmResolver = new DefaultAssemblyResolver();
        asmResolver.AddSearchDirectory(managedDir);
        var readerParams = new ReaderParameters
        {
            AssemblyResolver = asmResolver,
            ReadWrite = false,
            InMemory = true,
        };

        using var asm = AssemblyDefinition.ReadAssembly(backup, readerParams);
        var module = asm.MainModule;

        // 4. Build references into Gambonanza.ModHost.
        var modHostAsmRef = new AssemblyNameReference(ModHostAsmName, new Version(0, 1, 0, 0));
        module.AssemblyReferences.Add(modHostAsmRef);

        var modHostTypeRef = new TypeReference(
            "Gambonanza.ModHost", "ModHost", module, modHostAsmRef, valueType: false);

        var loadAllRef = new MethodReference(
            "LoadAll", module.TypeSystem.Void, modHostTypeRef) { HasThis = false };

        // OnSettingsOpenedInvoke(MonoBehaviour). Resolve MonoBehaviour from existing references.
        var monoBehaviourRef = ResolveMonoBehaviour(module);
        var onSettingsOpenedRef = new MethodReference(
            "OnSettingsOpenedInvoke", module.TypeSystem.Void, modHostTypeRef) { HasThis = false };
        onSettingsOpenedRef.Parameters.Add(new ParameterDefinition(monoBehaviourRef));

        var onHomeMenuOpenedRef = new MethodReference(
            "OnHomeMenuOpenedInvoke", module.TypeSystem.Void, modHostTypeRef) { HasThis = false };
        onHomeMenuOpenedRef.Parameters.Add(new ParameterDefinition(monoBehaviourRef));

        // 5. Patch GameManager.Start - prepend ModHost.LoadAll().
        var gameManager = module.GetType("Blukulele.Core.GameManager");
        var startMethod = gameManager?.Methods.FirstOrDefault(m => m.Name == "Start" && !m.IsStatic);
        if (gameManager == null || startMethod == null)
        {
            Console.Error.WriteLine("Could not find Blukulele.Core.GameManager.Start - aborting.");
            return 3;
        }
        var ilStart = startMethod.Body.GetILProcessor();
        var firstInstr = startMethod.Body.Instructions.First();
        ilStart.InsertBefore(firstInstr, ilStart.Create(OpCodes.Call, loadAllRef));
        Console.WriteLine("  patched -> Blukulele.Core.GameManager.Start (prepended ModHost.LoadAll)");

        // 6. Patch SettingsCanvas.OnEnable - append ModHost.OnSettingsOpenedInvoke(this) before every ret.
        var settingsCanvas = module.GetType("Blukulele.CHE.SettingsCanvas");
        var onEnable = settingsCanvas?.Methods.FirstOrDefault(m => m.Name == "OnEnable" && !m.IsStatic);
        if (settingsCanvas == null || onEnable == null)
        {
            Console.WriteLine("  warn: SettingsCanvas.OnEnable not found; settings injection disabled.");
        }
        else
        {
            var ilOnEnable = onEnable.Body.GetILProcessor();
            var retInstrs = onEnable.Body.Instructions.Where(i => i.OpCode == OpCodes.Ret).ToList();
            foreach (var ret in retInstrs)
            {
                ilOnEnable.InsertBefore(ret, ilOnEnable.Create(OpCodes.Ldarg_0));
                ilOnEnable.InsertBefore(ret, ilOnEnable.Create(OpCodes.Call, onSettingsOpenedRef));
            }
            Console.WriteLine("  patched -> Blukulele.CHE.SettingsCanvas.OnEnable (appended ModHost.OnSettingsOpenedInvoke)");
        }

        // 7. Patch CanvasMenu.OnEnable - append console button injection before every ret.
        var canvasMenu = module.GetType("Blukulele.CHE.CanvasMenu");
        var menuOnEnable = canvasMenu?.Methods.FirstOrDefault(m => m.Name == "OnEnable" && !m.IsStatic);
        if (canvasMenu == null || menuOnEnable == null)
        {
            Console.WriteLine("  warn: CanvasMenu.OnEnable not found; console button injection disabled.");
        }
        else
        {
            var ilMenu = menuOnEnable.Body.GetILProcessor();
            var rets = menuOnEnable.Body.Instructions.Where(i => i.OpCode == OpCodes.Ret).ToList();
            foreach (var ret in rets)
            {
                ilMenu.InsertBefore(ret, ilMenu.Create(OpCodes.Ldarg_0));
                ilMenu.InsertBefore(ret, ilMenu.Create(OpCodes.Call, onHomeMenuOpenedRef));
            }
            Console.WriteLine("  patched -> Blukulele.CHE.CanvasMenu.OnEnable (appended ModHost.OnHomeMenuOpenedInvoke)");
        }

        // 8. Add idempotency marker.
        AddMarker(asm);

        // 9. Write patched assembly out, then stamp it.
        //    detect "this dll is no longer ours" without re-reading the assembly.
        asm.Write(asmCsharp);
        WriteStamp(stamp, asmCsharp);
        Console.WriteLine($"  wrote   -> {Path.GetFileName(asmCsharp)}");
        Console.WriteLine("Done.");
        return 0;
    }

    private static string Sha256Hex(string path)
    {
        using var sha = SHA256.Create();
        using var fs = File.OpenRead(path);
        var hash = sha.ComputeHash(fs);
        return Convert.ToHexString(hash);
    }

    private static bool StampMatches(string stampPath, string dllPath)
    {
        if (!File.Exists(stampPath) || !File.Exists(dllPath)) return false;
        try { return string.Equals(File.ReadAllText(stampPath).Trim(), Sha256Hex(dllPath), StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }

    private static void WriteStamp(string stampPath, string dllPath)
    {
        try { File.WriteAllText(stampPath, Sha256Hex(dllPath)); }
        catch (Exception ex) { Console.Error.WriteLine($"  warn: could not write stamp file: {ex.Message}"); }
    }

    private static TypeReference ResolveMonoBehaviour(ModuleDefinition module)
    {
        var coreModule = module.AssemblyReferences.FirstOrDefault(r => r.Name == "UnityEngine.CoreModule");
        var unityRef   = coreModule
                      ?? module.AssemblyReferences.First(r => r.Name == "UnityEngine");
        return module.ImportReference(
            new TypeReference("UnityEngine", "MonoBehaviour", module, unityRef));
    }

    // Cheap probe: does this assembly contain our patch marker type? Used to decide
    // whether the on-disk Assembly-CSharp.dll is vanilla (no marker → refresh .orig)
    // or our patched output (marker present → leave .orig alone).
    private static bool HasMarker(string asmPath)
    {
        try
        {
            using var asm = AssemblyDefinition.ReadAssembly(asmPath, new ReaderParameters { InMemory = true });
            return asm.MainModule.GetType(MarkerType) != null;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"  warn: could not probe {Path.GetFileName(asmPath)} for patch marker: {ex.Message}");
            // Fail safe: claim it's patched so we don't accidentally overwrite a good .orig
            // with an unreadable .dll. The user can still force a refresh by deleting .orig.
            return true;
        }
    }

    private static void AddMarker(AssemblyDefinition asm)
    {
        var module = asm.MainModule;
        if (module.GetType(MarkerType) != null) return;

        var t = new TypeDefinition("", MarkerType,
            TypeAttributes.NotPublic | TypeAttributes.Sealed | TypeAttributes.Abstract,
            module.TypeSystem.Object);
        module.Types.Add(t);
    }
}
