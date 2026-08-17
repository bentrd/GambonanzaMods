using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Blukulele.CHE;
using Blukulele.Core;
using UnityEngine;
using UnityEngine.UI;

namespace Gambonanza.GambitApi
{
    public static class GambitRegistry
    {
        private static readonly List<GambitDefinition> _pending = new();
        private static bool _processing;
        private static readonly List<string> _unlockQueue = new();
        private static readonly Dictionary<string, (string name, string description)> _localizationEntries = new();
        // Inactive container that holds prefab templates. Prefabs themselves stay activeSelf=true,
        // so Instantiate(prefab) yields an active instance - but the template doesn't tick because
        // its parent is inactive (activeInHierarchy=false).
        private static GameObject _prefabRegistry;

        public static void Register(GambitDefinition def)
        {
            if (def == null) throw new ArgumentNullException(nameof(def));
            if (string.IsNullOrWhiteSpace(def.Id))
                throw new ArgumentException("Gambit ID cannot be empty.", nameof(def));

            Debug.Log($"[GambitApi] Register() called for '{def.Id}'.");

            // Cache localization entries for injection
            _localizationEntries[def.Id] = (def.Name, def.Description);

            if (CanRegisterImmediately())
            {
                DoRegister(def);
            }
            else
            {
                _pending.Add(def);
                TryStartProcessing();
            }
        }

        public static void RegisterAll(params GambitDefinition[] defs)
        {
            foreach (var def in defs)
                Register(def);
        }

        public static void ProcessPending()
        {
            if (_processing || _pending.Count == 0) return;
            _processing = true;

            var library = SingletonMonoBehaviour<GambitLibrary>.Instance;
            if (library == null)
            {
                Debug.LogError("[GambitApi] ProcessPending: GambitLibrary is null!");
                _processing = false;
                return;
            }

            var toProcess = new List<GambitDefinition>(_pending);
            _pending.Clear();

            foreach (var def in toProcess)
            {
                try { DoRegister(def); }
                catch (Exception ex) { Debug.LogError($"[GambitApi] Failed to register '{def.Id}': {ex}"); }
            }

            _processing = false;
        }

        private static bool CanRegisterImmediately()
        {
            var library = SingletonMonoBehaviour<GambitLibrary>.Instance;
            if (library == null) return false;
            var focusMapField = typeof(GambitLibrary).GetField("m_FocusMap", BindingFlags.NonPublic | BindingFlags.Instance);
            return library.GambitsInfo != null && library.GambitsInfo.Count > 0 && focusMapField?.GetValue(library) != null;
        }

        private static void DoRegister(GambitDefinition def)
        {
            var library = SingletonMonoBehaviour<GambitLibrary>.Instance;
            if (library == null) throw new InvalidOperationException("GambitLibrary is not available.");

            if (library.GambitsInfo.Any(g => g.ID == def.Id))
            {
                Debug.LogWarning($"[GambitApi] Gambit '{def.Id}' already registered. Skipping.");
                return;
            }

            // Fall back to a clearly-debug placeholder when no visual was supplied. Without this,
            // BuildGambitPrefab leaves the cloned vanilla template's sprite untouched and whichever
            // vanilla gambit was used as the clone source (currently the slot machine) bleeds
            // through, looking like the registration "worked" when it actually didn't.
            if (def.Visual == null)
            {
                Debug.LogWarning($"[GambitApi] Gambit '{def.Id}' has no visual. Using a magenta placeholder. Pass a sprite via WithVisual(...) to fix.");
                def.Visual = BuildPlaceholderSprite(def.Id);
            }

            // 1. Create ScriptableObject. Unity's Object.name defaults to the
            // type name ("SO_Gambit") when CreateInstance returns - every modded
            // SO would share that name, and vanilla's GambitLibrary.SelectGambits
            // dedup keys on it (the May-2026 patch tightened the check). Always
            // assign a unique value derived from def.Id.
            var soGambit = ScriptableObject.CreateInstance<SO_Gambit>();
            soGambit.name = def.Id;
            soGambit.ID = def.Id;
            soGambit.GambitName = $"{def.Id}_name";
            soGambit.GambitDescription = $"{def.Id}_description";
            soGambit.GambitVisual = def.Visual;
            soGambit.PriceCost = def.PriceCost;
            // Validated here as well as in GambitBuilder: GambitDefinition's fields are public,
            // so a mod can hand Register() a definition it assembled by hand and never touch
            // the builder's guards.
            soGambit.Rarity = GambitValidation.SanitizeRarity(def.Rarity, $"gambit '{def.Id}'");
            soGambit.Focus = GambitValidation.SanitizeFocus(def.Focus, $"gambit '{def.Id}'");
            soGambit.UnlockInfos = def.UnlockInfo;
            soGambit.GambitToUnlockToHaveAHint = def.GambitToUnlockToHaveAHint;

            soGambit.ShowPromotion = def.ShowPromotion;
            soGambit.ShowBless = def.ShowBless;
            soGambit.ShowGolden = def.ShowGolden;
            soGambit.ShowProtect = def.ShowProtect;
            soGambit.ShowTrap = def.ShowTrap;
            soGambit.ShowPhantom = def.ShowPhantom;
            soGambit.ShowWait = def.ShowWait;
            soGambit.ShowGoldenTile = def.ShowGoldenTile;
            soGambit.ShowBlessedTile = def.ShowBlessedTile;
            soGambit.ShowProtectedTile = def.ShowProtectedTile;
            soGambit.ShowTrapTile = def.ShowTrapTile;
            soGambit.ShowPhantomTile = def.ShowPhantomTile;
            soGambit.ShowLanding = def.ShowLanding;
            soGambit.ShowConsideredAs = def.ShowConsideredAs;

            // Defensive: backfill every public string field whose name looks
            // name- or id-related and that is still empty after our explicit
            // setup. Vanilla's GambitLibrary.SelectGambits dedupes on one of
            // these fields (the May-2026 game patch added a new one we didn't
            // know about), and two modded gambits with the SAME empty value
            // throws "Duplicate Gambit name detected: , index: N" - that
            // exception bubbles into ShopCanvas.ComputeGambits and renders the
            // shop empty. Filling every name/id field with a unique-per-id
            // value sidesteps any future renames the same way.
            BackfillEmptyNameFields(soGambit, def.Id);

            // 2. Build prefab
            GambitBehaviour prefab = BuildPrefab(def, soGambit, library);

            // 3. Add to library
            int index = library.GambitsInfo.Count;
            soGambit.Gambit_Library_Index = index;
            library.GambitsInfo.Add(soGambit);
            library.Gambits.Add(prefab);

            // 4. Reinitialize sorted lists.
            //
            // Vanilla Initialize() walks the ENTIRE library and throws
            // ArgumentOutOfRangeException on any Rarity/Gambit_Focus value its switch
            // doesn't cover. Step 3 has already published this entry, so a throw here used
            // to strand it in GambitsInfo permanently: steps 5-7 never ran, leaving a
            // nameless, never-unlocked card that the collection still painted - a chained
            // "Locked" tile - while every mod registering AFTER it hit the same throw as
            // Initialize() walked past the bad entry. GambitValidation should stop the known
            // offenders upstream; this rolls back whatever a future game patch invents.
            try
            {
                ReinitializeLibrary(library);
            }
            catch (Exception ex)
            {
                RollBackFailedRegistration(library, soGambit, prefab, def.Id, ex);
                throw;
            }

            // 5. Inject localization
            InjectLocalization(def);

            // 6. Queue unlock
            if (def.AutoUnlock)
                QueueUnlock(def.Id);

            // 7. Invalidate collection cache
            InvalidateCollectionCache();

            Debug.Log($"[GambitApi] Registered '{def.Id}' at index {index}.");
        }

        /// <summary>
        /// Undoes step 3 of <see cref="DoRegister"/> after Initialize() rejected the library:
        /// pulls the entry back out of both lists, destroys the objects created for it, drops
        /// its cached localization strings, and rebuilds the sorted lists - which the aborted
        /// Initialize() left half-filled, since ReinitializeLibrary clears them all before
        /// repopulating.
        /// </summary>
        private static void RollBackFailedRegistration(
            GambitLibrary library, SO_Gambit soGambit, GambitBehaviour prefab, string id, Exception cause)
        {
            Debug.LogError(
                $"[GambitApi] '{id}' was rejected by GambitLibrary.Initialize() - rolling it back so it " +
                $"can't leave a locked ghost card or break the mods that register after it. " +
                $"Cause: {cause.GetBaseException().Message}");

            try
            {
                library.GambitsInfo.Remove(soGambit);
                library.Gambits.Remove(prefab);
                _localizationEntries.Remove(id);

                if (prefab != null) UnityEngine.Object.Destroy(prefab.gameObject);
                if (soGambit != null) UnityEngine.Object.Destroy(soGambit);

                // Rebuild from the cleaned list - with the offender gone this should succeed.
                ReinitializeLibrary(library);
            }
            catch (Exception ex)
            {
                Debug.LogError(
                    $"[GambitApi] Rollback of '{id}' failed. Something else in the library is also " +
                    $"unsortable, so gambit lists stay inconsistent until the game restarts: {ex}");
            }
        }

        private static void InjectLocalization(GambitDefinition def)
        {
            var locManager = SingletonMonoBehaviour<LocalizationManager>.Instance;
            if (locManager == null)
            {
                Debug.LogWarning("[GambitApi] LocalizationManager not found, tooltip text will be empty.");
                return;
            }

            // Force load if not cached
            var traduction = locManager.GetTraduction();
            if (traduction == null)
            {
                Debug.LogWarning("[GambitApi] GetTraduction() returned null.");
                return;
            }

            var gambitNode = traduction["gambit"];
            if (gambitNode == null)
            {
                Debug.LogWarning("[GambitApi] traduction['gambit'] node not found.");
                return;
            }

            string nameKey = $"{def.Id}_name";
            string descKey = $"{def.Id}_description";

            // The JSON implementation uses custom setters via indexer
            gambitNode[nameKey] = def.Name;
            gambitNode[descKey] = def.Description;

            Debug.Log($"[GambitApi] Injected localization: '{nameKey}' = '{def.Name}', '{descKey}' = '{def.Description}'");
        }

        /// <summary>
        /// Re-checks that every registered gambit's display strings are still present in
        /// the game's cached traduction JSON and re-writes any that are missing.
        ///
        /// GetTraduction() caches one parsed JSONNode per language and rebuilds it from
        /// the vanilla text asset whenever SettingsData.CurrentLanguage changes - the
        /// settings-screen language arrows and the Steam first-launch auto-detect both
        /// trigger that rebuild, silently dropping everything InjectLocalization wrote
        /// and leaving custom gambits with empty names/descriptions in the collection.
        /// GambitApiHost calls this from LocalizationManager.OnChangeLanguage and from a
        /// slow watchdog (the auto-detect path never fires the event).
        /// </summary>
        public static void EnsureLocalizationInjected()
        {
            if (_localizationEntries.Count == 0) return;
            if (!SingletonMonoBehaviour<LocalizationManager>.IsCreated()) return;

            JSONNode gambitNode;
            try
            {
                var traduction = SingletonMonoBehaviour<LocalizationManager>.Instance?.GetTraduction();
                gambitNode = traduction?["gambit"];
            }
            catch
            {
                // Boot-order race (DataManager/settings not loaded yet) - the watchdog
                // will try again on its next tick.
                return;
            }
            if (gambitNode == null) return;

            int repaired = 0;
            foreach (var entry in _localizationEntries)
            {
                string nameKey = entry.Key + "_name";
                // A missing key yields a lazy/empty node, so test the string value
                // rather than the node itself.
                if (!string.IsNullOrEmpty(gambitNode[nameKey]?.Value)) continue;
                gambitNode[nameKey] = entry.Value.name;
                gambitNode[entry.Key + "_description"] = entry.Value.description;
                repaired++;
            }
            if (repaired > 0)
                Debug.Log($"[GambitApi] Traduction cache was rebuilt (language change?) - re-injected {repaired} gambit localization entr{(repaired == 1 ? "y" : "ies")}.");
        }

        // Walk every public/non-public instance string field AND settable string
        // property on the SO, filling any blank value whose name looks
        // name/id-related with an id-suffixed token. Properties are scanned in
        // addition to fields because Unity surfaces some name-ish fields only
        // through wrappers (e.g. Object.name is property-only, no settable
        // backing field). This is the second-line defence behind the explicit
        // soGambit.name / .ID / .GambitName assignments earlier - if a future
        // patch adds yet another required name field we cover it automatically.
        private static bool _diagnosticsLogged;
        private static void BackfillEmptyNameFields(SO_Gambit so, string id)
        {
            if (so == null || string.IsNullOrEmpty(id)) return;
            var t = typeof(SO_Gambit);
            const BindingFlags F = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

            foreach (var f in t.GetFields(F))
            {
                if (f.FieldType != typeof(string)) continue;
                if (!LooksNameOrIdField(f.Name)) continue;
                string current;
                try { current = (string)f.GetValue(so); } catch { continue; }
                if (!string.IsNullOrWhiteSpace(current)) continue;
                try { f.SetValue(so, $"{id}_{StripBackingPrefix(f.Name)}"); }
                catch (Exception ex) { Debug.LogWarning($"[GambitApi] could not backfill SO_Gambit.{f.Name}: {ex.Message}"); }
            }

            foreach (var p in t.GetProperties(F))
            {
                if (p.PropertyType != typeof(string)) continue;
                if (!p.CanRead || !p.CanWrite) continue;
                if (p.GetIndexParameters().Length != 0) continue;
                if (!LooksNameOrIdField(p.Name)) continue;
                string current;
                try { current = (string)p.GetValue(so); } catch { continue; }
                if (!string.IsNullOrWhiteSpace(current)) continue;
                try { p.SetValue(so, $"{id}_{StripBackingPrefix(p.Name)}"); }
                catch (Exception ex) { Debug.LogWarning($"[GambitApi] could not backfill SO_Gambit.{p.Name}: {ex.Message}"); }
            }

            // One-time snapshot of every string-typed field+property on a
            // vanilla SO vs ours. If the shop crashes again with the same
            // duplicate-name exception, the diff in the log identifies the
            // offender immediately.
            if (!_diagnosticsLogged) { LogStringFieldDiff(so); _diagnosticsLogged = true; }
        }

        private static void LogStringFieldDiff(SO_Gambit ours)
        {
            try
            {
                if (!SingletonMonoBehaviour<GambitLibrary>.IsCreated()) return;
                var lib = SingletonMonoBehaviour<GambitLibrary>.Instance;
                if (lib?.GambitsInfo == null || lib.GambitsInfo.Count == 0) return;
                SO_Gambit vanilla = null;
                foreach (var v in lib.GambitsInfo) { if (v != null && v != ours) { vanilla = v; break; } }
                if (vanilla == null) return;
                var t = typeof(SO_Gambit);
                const BindingFlags F = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
                Debug.Log($"[GambitApi][diag] vanilla.name='{vanilla.name}' ours.name='{ours.name}'");
                foreach (var f in t.GetFields(F))
                {
                    if (f.FieldType != typeof(string)) continue;
                    string v = null, o = null;
                    try { v = (string)f.GetValue(vanilla); } catch { }
                    try { o = (string)f.GetValue(ours);    } catch { }
                    if (string.IsNullOrEmpty(v) == string.IsNullOrEmpty(o)) continue; // both empty or both filled - uninteresting
                    Debug.Log($"[GambitApi][diag]   field {f.Name}: vanilla='{v}', ours='{o}'");
                }
                foreach (var p in t.GetProperties(F))
                {
                    if (p.PropertyType != typeof(string) || !p.CanRead || p.GetIndexParameters().Length != 0) continue;
                    string v = null, o = null;
                    try { v = (string)p.GetValue(vanilla); } catch { }
                    try { o = (string)p.GetValue(ours);    } catch { }
                    if (string.IsNullOrEmpty(v) == string.IsNullOrEmpty(o)) continue;
                    Debug.Log($"[GambitApi][diag]   prop  {p.Name}: vanilla='{v}', ours='{o}'");
                }
            }
            catch (Exception ex) { Debug.LogWarning($"[GambitApi][diag] string-field diff dump threw: {ex.Message}"); }
        }

        private static bool LooksNameOrIdField(string fieldName)
        {
            if (string.IsNullOrEmpty(fieldName)) return false;
            // Match "name", "id", "key" (loc keys) - case-insensitive substring.
            return fieldName.IndexOf("name", StringComparison.OrdinalIgnoreCase) >= 0
                || fieldName.IndexOf("identifier", StringComparison.OrdinalIgnoreCase) >= 0
                || fieldName.Equals("m_ID", StringComparison.Ordinal)
                || fieldName.Equals("ID", StringComparison.Ordinal)
                || fieldName.IndexOf("key", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static string StripBackingPrefix(string fieldName)
        {
            if (fieldName.StartsWith("m_", StringComparison.Ordinal) && fieldName.Length > 2) return fieldName.Substring(2);
            if (fieldName.StartsWith("_",  StringComparison.Ordinal) && fieldName.Length > 1) return fieldName.Substring(1);
            return fieldName;
        }

        private static void ReinitializeLibrary(GambitLibrary library)
        {
            library.Gambits_Common.Clear();
            library.Gambits_Rare.Clear();
            library.Gambits_Epic.Clear();
            library.Gambits_Legendary.Clear();
            library.Gambit_PAWN.Clear();
            library.Gambit_ROOK.Clear();
            library.Gambit_KNIGHT.Clear();
            library.Gambit_BISHOP.Clear();
            library.Gambit_QUEEN.Clear();
            library.Gambit_KING.Clear();
            library.Gambit_MONEY.Clear();
            library.Gambit_OTHER.Clear();
            library.Gambit_PROMOTION.Clear();
            library.Gambit_WAIT.Clear();
            library.Gambit_PHANTOM.Clear();
            library.Gambit_BLESS.Clear();
            library.Gambit_PROTECTIVE.Clear();
            library.Gambit_TRAP.Clear();
            library.Gambit_GOLDEN.Clear();
            library.Gambit_LAND.Clear();
            library.Gambit_SACRIFICE.Clear();
            library.Gambit_PIECE_SELLER.Clear();
            library.Gambit_GAMBIT_SELLER.Clear();
            library.Gambit_CRUMBLE.Clear();

            var initMethod = typeof(GambitLibrary).GetMethod("Initialize", BindingFlags.NonPublic | BindingFlags.Instance);
            if (initMethod != null)
            {
                initMethod.Invoke(library, null);
                Debug.Log("[GambitApi] Reinitialized GambitLibrary.");
            }
        }

        private static GambitBehaviour BuildPrefab(GambitDefinition def, SO_Gambit soGambit, GambitLibrary library)
        {
            string templateId = def.TemplateGambitId;
            GambitBehaviour templatePrefab = null;

            if (!string.IsNullOrEmpty(templateId))
            {
                templatePrefab = FindPrefabById(library, templateId);
                if (templatePrefab == null)
                    Debug.LogWarning($"[GambitApi] Template '{templateId}' not found, using fallback.");
            }

            if (templatePrefab == null && library.Gambits.Count > 0)
                templatePrefab = library.Gambits[0];

            if (templatePrefab == null)
                throw new InvalidOperationException("No template prefab found.");

            // Park the template under an inactive registry GameObject. The clone itself stays
            // activeSelf=true so Object.Instantiate(prefab) yields an active instance, but the
            // template doesn't tick because activeInHierarchy=false through the inactive parent.
            var registry = GetOrCreatePrefabRegistry();
            var clone = UnityEngine.Object.Instantiate(templatePrefab, registry.transform);

            var oldBase = clone.GetComponent<BaseGambit>();
            if (oldBase != null)
                UnityEngine.Object.DestroyImmediate(oldBase);

            Type gambitType = def.BaseGambitType ?? typeof(SimpleGambit);
            var newBase = (BaseGambit)clone.gameObject.AddComponent(gambitType);
            if (newBase is SimpleGambit simple && def.TriggerAction != null)
                simple.OnTriggerAction = def.TriggerAction;

            // Heals the stranded-icon case where a mod triggers its visual effect
            // during its own spawn animation and kills the fly-to-slot tween.
            if (clone.GetComponent<GambitPlacementGuard>() == null)
                clone.gameObject.AddComponent<GambitPlacementGuard>();

            clone.Info = soGambit;

            // Override the cloned template's in-game sprite with the modded visual.
            // The collection UI reads SO_Gambit.GambitVisual (already set), but the
            // in-game piece reads GambitBehaviour.m_Sprite. Custom mod sprites can be any
            // pixel size - we rebuild the sprite with a PPU computed from the template's
            // world height so the modded gambit ends up at the same on-board size as vanilla,
            // and warn (below) if the aspect ratio differs enough to look squashed.
            if (def.Visual != null)
            {
                var spriteField = typeof(GambitBehaviour).GetField("m_Sprite", BindingFlags.NonPublic | BindingFlags.Instance);
                var highlightField = typeof(GambitBehaviour).GetField("m_SpriteHighlight", BindingFlags.NonPublic | BindingFlags.Instance);
                var templateSr = spriteField?.GetValue(clone) as SpriteRenderer;
                Sprite inGameSprite = def.Visual;
                if (templateSr != null && templateSr.sprite != null && def.Visual.texture != null)
                {
                    var tex = def.Visual.texture;
                    // Pixel-art sprites need point filtering (bilinear bleeds edge pixels into a
                    // visible halo) and clamp wrapping (repeat sampling pulls from the opposite
                    // edge - that's where the green stripe was coming from).
                    try { tex.filterMode = FilterMode.Point; } catch { /* read-only texture */ }
                    try { tex.wrapMode = TextureWrapMode.Clamp; } catch { /* read-only texture */ }

                    var templateSprite = templateSr.sprite;
                    var templateRect = templateSprite.rect;
                    float templateAspect = templateRect.height > 0 ? templateRect.width / templateRect.height : 0f;
                    float ourAspect = tex.height > 0 ? (float)tex.width / tex.height : 0f;
                    if (templateAspect > 0f && ourAspect > 0f)
                    {
                        float aspectDelta = Mathf.Abs(ourAspect - templateAspect) / templateAspect;
                        // The PPU rescale below makes any size render at the correct on-board height,
                        // but a wildly different aspect ratio will look squashed/stretched compared
                        // to vanilla cards. Warn (not error) so the modder knows the canonical size.
                        if (aspectDelta > 0.10f)
                        {
                            Debug.LogWarning(
                                $"[GambitApi] Gambit '{def.Id}' visual is {tex.width}x{tex.height}; " +
                                $"vanilla template is {(int)templateRect.width}x{(int)templateRect.height}. " +
                                $"Aspect ratio differs by {aspectDelta:P0} - sprite will render but look squashed/stretched.");
                        }
                    }

                    float templateWorldH = templateSprite.bounds.size.y;
                    float ourPixelH = tex.height;
                    if (templateWorldH > 0.0001f && ourPixelH > 0)
                    {
                        // ppu = ourPixelH / desiredWorldH. desiredWorldH = templateWorldH * scale,
                        // so dividing by scale shrinks (scale < 1) or grows (scale > 1) the sprite.
                        float scale = def.VisualScale > 0f ? def.VisualScale : 1f;
                        float ppu = ourPixelH / (templateWorldH * scale);
                        // Match the template sprite's pivot so the in-game piece sits on the same
                        // anchor (vanilla pieces are typically bottom-pivoted so they stand on the
                        // sell UI base; using center-pivot offsets the sprite vertically).
                        Vector2 pivot = new Vector2(0.5f, 0.5f);
                        var tRect = templateSprite.rect;
                        if (tRect.width > 0 && tRect.height > 0)
                        {
                            var tp = templateSprite.pivot;
                            pivot = new Vector2(tp.x / tRect.width, tp.y / tRect.height);
                        }
                        inGameSprite = Sprite.Create(
                            tex,
                            new Rect(0, 0, tex.width, tex.height),
                            pivot,
                            ppu);
                        inGameSprite.name = def.Id + "_ingame";
                    }
                }
                if (templateSr != null) templateSr.sprite = inGameSprite;
                if (highlightField?.GetValue(clone) is SpriteRenderer shr) shr.sprite = inGameSprite;
            }

            return clone;
        }

        private static GameObject GetOrCreatePrefabRegistry()
        {
            if (_prefabRegistry != null) return _prefabRegistry;
            _prefabRegistry = new GameObject("[GambitApi] PrefabRegistry");
            _prefabRegistry.SetActive(false);
            UnityEngine.Object.DontDestroyOnLoad(_prefabRegistry);
            return _prefabRegistry;
        }

        /// <summary>
        /// 21x30 magenta-on-purple square stamped with the gambit ID's first letter so a missing
        /// sprite is impossible to confuse with a real card. Aspect (~0.7) matches the reference
        /// kamikaze sample so the in-game piece doesn't show the squashed-aspect warning.
        /// </summary>
        private static Sprite BuildPlaceholderSprite(string id)
        {
            const int W = 21, H = 30;
            var bg = new Color(0.45f, 0.0f, 0.55f, 1f);
            var fg = new Color(1f, 0.15f, 1f, 1f);
            var tex = new Texture2D(W, H, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
            var pixels = new Color[W * H];
            for (int i = 0; i < pixels.Length; i++) pixels[i] = bg;
            // 1px border so it reads as a card outline at low PPU.
            for (int x = 0; x < W; x++) { pixels[x] = fg; pixels[(H - 1) * W + x] = fg; }
            for (int y = 0; y < H; y++) { pixels[y * W] = fg; pixels[y * W + (W - 1)] = fg; }
            // 5x7 question mark glyph centered horizontally and biased downward so it reads on
            // the in-game card. Two rows of '?' so the placeholder is unmistakable.
            char glyph = string.IsNullOrEmpty(id) ? '?' : char.ToUpperInvariant(id[0]);
            DrawGlyph(pixels, W, H, glyph, originX: (W - 5) / 2, originY: 11, fg);
            DrawGlyph(pixels, W, H, '?', originX: (W - 5) / 2, originY: 2, fg);
            tex.SetPixels(pixels);
            tex.Apply();
            return Sprite.Create(tex, new Rect(0, 0, W, H), new Vector2(0.5f, 0.5f), 100f);
        }

        // Tiny 5x7 bitmap font; each entry is rows top-to-bottom of a 5-bit bitmask.
        // Only covers letters used by sample mod IDs and '?'. Unknown chars fall back to '?'.
        private static readonly System.Collections.Generic.Dictionary<char, byte[]> _Glyphs = new()
        {
            ['?'] = new byte[] { 0b01110, 0b10001, 0b00010, 0b00100, 0b00100, 0b00000, 0b00100 },
            ['A'] = new byte[] { 0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001 },
            ['K'] = new byte[] { 0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001 },
        };

        private static void DrawGlyph(Color[] pixels, int w, int h, char ch, int originX, int originY, Color color)
        {
            if (!_Glyphs.TryGetValue(ch, out var rows)) rows = _Glyphs['?'];
            // rows[0] is the top row; iterate bottom-up because pixels[] is bottom-origin.
            for (int row = 0; row < rows.Length; row++)
            {
                int y = originY + (rows.Length - 1 - row);
                if (y < 0 || y >= h) continue;
                byte mask = rows[row];
                for (int col = 0; col < 5; col++)
                {
                    if ((mask & (1 << (4 - col))) == 0) continue;
                    int x = originX + col;
                    if (x < 0 || x >= w) continue;
                    pixels[y * w + x] = color;
                }
            }
        }

        private static GambitBehaviour FindPrefabById(GambitLibrary library, string id)
        {
            var data = library.GetGambitPerId(id);
            if (data == null) return null;
            int idx = library.GambitsInfo.IndexOf(data);
            if (idx < 0 || idx >= library.Gambits.Count) return null;
            return library.Gambits[idx];
        }

        private static void InvalidateCollectionCache()
        {
            // Find ALL GambitCollectionSlide instances, including inactive ones
            var slides = Resources.FindObjectsOfTypeAll<GambitCollectionSlide>();
            if (slides != null && slides.Length > 0)
            {
                var initField = typeof(GambitCollectionSlide).GetField("m_Initialize", BindingFlags.NonPublic | BindingFlags.Instance);
                foreach (var slide in slides)
                {
                    initField?.SetValue(slide, false);
                    if (slide.GetComponent<CollectionPaginationPatch>() == null)
                    {
                        slide.gameObject.AddComponent<CollectionPaginationPatch>();
                        Debug.Log($"[GambitApi] Attached CollectionPaginationPatch to '{slide.gameObject.name}'.");
                    }
                }
                Debug.Log($"[GambitApi] Invalidated and patched {slides.Length} collection slide(s).");
            }
            else
            {
                Debug.Log("[GambitApi] No collection slides found (active or inactive).");
            }

            // Patch every RunInfoCanvas (and CollectionCanvas which subclasses it) so the
            // hardcoded "X/200" denominator stays accurate against the modded library count.
            var canvases = Resources.FindObjectsOfTypeAll<RunInfoCanvas>();
            if (canvases != null)
            {
                foreach (var canvas in canvases)
                {
                    if (canvas.GetComponent<GambitCountPatch>() == null)
                    {
                        canvas.gameObject.AddComponent<GambitCountPatch>();
                        Debug.Log($"[GambitApi] Attached GambitCountPatch to '{canvas.gameObject.name}'.");
                    }
                }
            }
        }

        private static void QueueUnlock(string id)
        {
            if (!_unlockQueue.Contains(id))
                _unlockQueue.Add(id);

#pragma warning disable CS0618
            var host = UnityEngine.Object.FindObjectOfType<GambitApiHost>();
#pragma warning restore CS0618
            if (host != null)
                host.StartCoroutine(UnlockMonitorRoutine());
        }

        private static IEnumerator UnlockMonitorRoutine()
        {
            float elapsed = 0f;
            while (_unlockQueue.Count > 0 && elapsed < 10f)
            {
                var um = SingletonMonoBehaviour<GambitUnlockManager>.Instance;
                if (um != null && um.UnlockedGambits != null && um.UnlockedGambits.Count > 0)
                {
                    var toUnlock = new List<string>(_unlockQueue);
                    _unlockQueue.Clear();
                    foreach (var id in toUnlock)
                    {
                        try { um.UnlockGambit(id); }
                        catch (Exception ex) { Debug.LogError($"[GambitApi] Unlock failed '{id}': {ex}"); }
                    }
                    yield break;
                }
                yield return null;
                elapsed += Time.deltaTime;
            }
        }

        /// <summary>
        /// Removes unlocked-gambit ids from the game's SAVE DATA that no longer
        /// exist in the library. AutoUnlock writes custom ids (e.g. "kamikaze")
        /// into DataManager.Data.GambitUnlocked, which the game persists - so
        /// uninstalling or disabling a gambit mod used to leave its ghost behind:
        /// the collection count read "201/200" and stale entries lingered forever.
        ///
        /// Called after ProcessPending, when every mod that will register this
        /// session has registered. Vanilla ids all exist in GambitsInfo, so only
        /// genuinely orphaned modded ids can match; the count guard makes sure we
        /// never sweep against a half-initialised library.
        /// </summary>
        public static void PurgeStaleUnlockData()
        {
            try
            {
                var library = SingletonMonoBehaviour<GambitLibrary>.IsCreated()
                    ? SingletonMonoBehaviour<GambitLibrary>.Instance : null;
                if (library?.GambitsInfo == null || library.GambitsInfo.Count < 100)
                {
                    Debug.Log("[GambitApi] Stale-unlock sweep skipped: library not fully initialised.");
                    return;
                }

                var unlocked = DataManager.Instance?.Data?.GambitUnlocked;
                if (unlocked == null || unlocked.Count == 0) return;

                var valid = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var so in library.GambitsInfo)
                    if (so != null && !string.IsNullOrEmpty(so.ID)) valid.Add(so.ID);

                var removed = new List<string>();
                for (int i = unlocked.Count - 1; i >= 0; i--)
                {
                    var id = unlocked[i]?.ToString();
                    if (string.IsNullOrEmpty(id) || valid.Contains(id)) continue;
                    removed.Add(id);
                    unlocked.RemoveAt(i);
                }
                if (removed.Count == 0) return;

                Debug.Log($"[GambitApi] Removed {removed.Count} stale unlocked gambit id(s) from save data (mod removed/disabled): {string.Join(", ", removed)}");

                // Persist right away if DataManager exposes a parameterless save;
                // otherwise the game writes the cleaned list on its next own save.
                try
                {
                    var dm = DataManager.Instance;
                    var save = typeof(DataManager)
                        .GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                        .FirstOrDefault(m => m.Name.IndexOf("save", StringComparison.OrdinalIgnoreCase) >= 0
                                          && m.GetParameters().Length == 0 && !m.IsGenericMethod);
                    if (save != null)
                    {
                        save.Invoke(dm, null);
                        Debug.Log($"[GambitApi] Save data persisted via DataManager.{save.Name}().");
                    }
                }
                catch (Exception ex)
                {
                    Debug.LogWarning($"[GambitApi] Could not persist the cleaned save immediately ({ex.Message}) - the game will save it itself.");
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[GambitApi] Stale-unlock sweep failed: {ex.Message}");
            }
        }

        private static void TryStartProcessing()
        {
            if (_processing) return;
#pragma warning disable CS0618
            var host = UnityEngine.Object.FindObjectOfType<GambitApiHost>();
#pragma warning restore CS0618
            if (host != null)
                host.StartCoroutine(WaitAndProcess());
        }

        private static IEnumerator WaitAndProcess()
        {
            yield return null;
            ProcessPending();
        }
    }
}
