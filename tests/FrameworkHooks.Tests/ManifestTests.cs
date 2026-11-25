using System.Text.Json;
using Gambonanza.ModHost;

internal static class ManifestTests
{
    public static void CustomKeybinds()
    {
        const string json = """
            {
              "id": "StockSwap",
              "name": "Stock Swap",
              "author": "Minty",
              "version": "1.0.0",
              "entry": "StockSwap.Mod",
              "enabled": false,
              "gameVersion": ">=1.0",
              "dependencies": ["GambitApi"],
              "stockSwapSettings": { "blockedSlots": [0, 4], "revision": 9007199254740993 },
              "keybinds": [
                { "name": "swapHoveredPiece", "description": "Swap the \"hovered\" piece", "key": "Mouse2", "context": "board" },
                { "name": "alternate", "description": "Alternate swap", "key": "Shift+Mouse2" }
              ]
            }
            """;
        var directory = Directory.CreateTempSubdirectory("gambonanza-manifest-tests-");
        try
        {
            var path = Path.Combine(directory.FullName, "mod.json");
            File.WriteAllText(path, json);
            var manifest = Parse(File.ReadAllText(path));
            Program.Assert(!manifest.enabled, "explicitly disabled mod was enabled");

            var registry = new ModRegistry();
            registry.LoadMod(directory.FullName, manifest);
            var binding = registry.AllKeybinds("StockSwap").Single(bind => bind.Name == "swapHoveredPiece");
            Program.Equal("Mouse2", binding.Key, "manifest middle-click binding missing from registry");
            Program.Equal("Swap the \"hovered\" piece", binding.Description, "description was not decoded");
            Program.Assert(registry.TrySetKeybind("StockSwap", "swapHoveredPiece", "Ctrl+Mouse2", out var error), error);

            var savedJson = File.ReadAllText(path);
            var saved = Parse(savedJson);
            Program.Equal("StockSwap", saved.id, "rebind lost the mod ID");
            Program.Equal("Stock Swap", saved.name, "rebind lost the mod name");
            Program.Equal("Minty", saved.author, "rebind lost the mod author");
            Program.Equal("1.0.0", saved.version, "rebind lost the mod version");
            Program.Equal("StockSwap.Mod", saved.entry, "rebind lost the mod entry point");
            Program.Equal(">=1.0", saved.gameVersion, "rebind lost the game version");
            Program.Equal("GambitApi", saved.dependencies.Single(), "rebind lost the dependency");
            Program.Assert(!saved.enabled, "rebind enabled the disabled mod");
            var savedBinding = saved.keybinds.Single(bind => bind.name == "swapHoveredPiece");
            Program.Equal("Ctrl+Mouse2", savedBinding.key, "rebind was not persisted");
            Program.Equal(binding.Description, savedBinding.description, "rebind lost its description");
            Program.Equal("Shift+Mouse2", saved.keybinds.Single(bind => bind.name == "alternate").key, "rebind changed another binding");

            using var savedDocument = JsonDocument.Parse(savedJson);
            var root = savedDocument.RootElement;
            var settings = root.GetProperty("stockSwapSettings");
            var blockedSlots = settings.GetProperty("blockedSlots");
            Program.Assert(blockedSlots.EnumerateArray().Select(slot => slot.GetInt32()).SequenceEqual(new[] { 0, 4 }),
                "rebind changed custom manifest metadata");
            Program.Equal(9007199254740993L, settings.GetProperty("revision").GetInt64(), "rebind rounded a custom metadata number");
            var customBinding = root.GetProperty("keybinds").EnumerateArray()
                .Single(bind => bind.GetProperty("name").GetString() == "swapHoveredPiece");
            Program.Equal("board", customBinding.GetProperty("context").GetString(), "rebind lost custom keybind metadata");
        }
        finally
        {
            directory.Delete(recursive: true);
        }
    }

    public static void OverlayDefault()
    {
        const string modId = "EnemyThreatOverlay";
        const string bindName = "threatDisplay";
        foreach (var version in new[] { "1.0.0", "1.2.0" })
            Program.Equal("Space", LoadOverlay(version: version).GetKeybind(modId, bindName),
                $"legacy overlay {version} lost its shipped binding");

        foreach (var key in new[] { "Mouse2", "unset" })
        {
            var registry = LoadOverlay($$""", "keybinds": [{ "name": "threatDisplay", "key": "{{key}}" }]""");
            var binding = registry.AllKeybinds(modId).Single(bind => bind.Name == bindName);
            Program.Equal(key, binding.Key, "bundled default replaced an explicit binding");
        }

        var empty = LoadOverlay(""", "keybinds": []""");
        Program.Assert(empty.AllKeybinds(modId).All(bind => bind.Name != bindName),
            "bundled default was restored despite an explicit empty keybind array");
    }

    private static ModRegistry LoadOverlay(string keybindsField = "", string version = "1.2.0")
    {
        var manifest = Parse($$"""
            {
              "id": "EnemyThreatOverlay",
              "entry": "Gambonanza.EnemyThreatOverlay.EnemyThreatOverlayMod",
              "version": "{{version}}"
              {{keybindsField}}
            }
            """);
        Program.Assert(manifest.enabled, "a manifest without enabled should default to enabled");
        // A disabled shell exposes manifest bindings without loading a game DLL.
        manifest.enabled = false;
        var registry = new ModRegistry();
        registry.LoadMod("/unused", manifest);
        return registry;
    }

    private static ModManifest Parse(string json)
    {
        var manifest = ModManifest.TryParse(json, out var parseError);
        Program.Assert(manifest != null, "could not parse manifest: " + parseError);
        Program.Assert(manifest.IsValid(out var validationError), "invalid manifest: " + validationError);
        return manifest;
    }
}
