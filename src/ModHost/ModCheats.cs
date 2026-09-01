using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Gambonanza.ModSdk;
using UnityEngine;

namespace Gambonanza.ModHost
{
    internal static class ModCheats
    {
        private static readonly string[] PieceNames = { "pawn", "rook", "knight", "bishop", "queen", "king" };

        public static void Register(IConsoleApi console)
        {
            console.RegisterCommand("give", "give money, stock pieces, or gambits: give money 50 | give piece queen 2 | give gambit thunder", args => Give(console, args), CompleteGive);
            console.RegisterCommand("set money", "set current money: set money 999", args => SetMoney(console, args));
            console.RegisterCommand("run", "show current run state", _ => PrintRunState(console));
            console.RegisterCommand("wave set", "set current wave index: wave set 10", args => SetWave(console, args));
            console.RegisterCommand("wave add", "add to current wave index: wave add 5", args => AddWave(console, args));
            console.RegisterCommand("list pieces", "list piece ids usable by give piece", _ => console.PrintInfo(string.Join(", ", PieceNames)));
            console.RegisterCommand("list gambits", "list gambit ids; optional filter: list gambits thunder", args => ListGambits(console, args), CompleteGambitNames);
            console.RegisterCommand("list schemes", "list board colour schemes and their unlock state", _ => ListSchemes(console));
            console.RegisterCommand("scheme set", "apply a board colour scheme: scheme set emerald", args => SetScheme(console, args), CompleteSchemeNames);
            console.RegisterCommand("scheme unlock", "unlock a board scheme (or 'all'): scheme unlock final", args => UnlockScheme(console, args), CompleteSchemeNames);
        }

        // ---- Board colour schemes (added by the 2026-05 "Customize" update) -------
        //
        // Library.TileSchemes is the catalogue; SchemeUnlockerManager owns the
        // unlocked set and persists it; CustomizationManager.OnChangeScheme is what
        // live TileVisual components listen to. Setting DataManager.SettingData.TileIndex
        // alone only changes what the Settings tab shows on next open - you must also
        // fire OnChangeScheme to repaint the board that's already on screen.

        private static object[] SchemeCatalogue()
        {
            var lib = Instance("Blukulele.CHE.Library");
            if (lib == null) return Array.Empty<object>();
            var arr = GetFieldOrProp(lib, "TileSchemes") as Array;
            return arr == null ? Array.Empty<object>() : arr.Cast<object>().Where(s => s != null).ToArray();
        }

        private static string SchemeId(object scheme)
            => scheme == null ? null : (string)Field(scheme, "SchemeId")?.GetValue(scheme);

        private static void ListSchemes(IConsoleApi console)
        {
            var schemes = SchemeCatalogue();
            if (schemes.Length == 0) { console.PrintWarn("Library not ready - reach the main menu first."); return; }

            var unlocker = Instance("Blukulele.CHE.SchemeUnlockerManager");
            int current = CurrentSchemeIndex();
            for (int i = 0; i < schemes.Length; i++)
            {
                var id = SchemeId(schemes[i]);
                if (string.IsNullOrEmpty(id)) continue;
                bool unlocked = unlocker != null && Convert.ToBoolean(Invoke(unlocker, "IsUnlocked", id) ?? false);
                console.PrintInfo($"  [{i}] {id}{(unlocked ? "" : "  (locked)")}{(i == current ? "   <- active" : "")}");
            }
        }

        private static int CurrentSchemeIndex()
        {
            var data = DataManagerInstance();
            if (data == null) return -1;
            var settings = GetFieldOrProp(data, "SettingData");
            if (settings == null) return -1;
            try { return Convert.ToInt32(GetFieldOrProp(settings, "TileIndex")); } catch { return -1; }
        }

        private static object DataManagerInstance()
        {
            var t = GameType("Blukulele.Core.DataManager");
            return t?.GetField("Instance", Any)?.GetValue(null);
        }

        /// <summary>Resolve a scheme argument that may be an id ("emerald") or an index ("7").</summary>
        private static int ResolveSchemeIndex(object[] schemes, string query)
        {
            if (TryInt(query, out var idx)) return idx >= 0 && idx < schemes.Length ? idx : -1;
            var q = Norm(query);
            for (int i = 0; i < schemes.Length; i++)
                if (Norm(SchemeId(schemes[i])) == q) return i;
            for (int i = 0; i < schemes.Length; i++)
                if (Norm(SchemeId(schemes[i]) ?? "").Contains(q)) return i;
            return -1;
        }

        private static void SetScheme(IConsoleApi console, string[] args)
        {
            if (args == null || args.Length < 1) { console.PrintWarn("usage: scheme set <id|index>   (see: list schemes)"); return; }
            var schemes = SchemeCatalogue();
            if (schemes.Length == 0) { console.PrintWarn("Library not ready - reach the main menu first."); return; }

            int idx = ResolveSchemeIndex(schemes, string.Join(" ", args));
            if (idx < 0) { console.PrintWarn($"unknown scheme '{string.Join(" ", args)}'. Try: list schemes"); return; }

            var id = SchemeId(schemes[idx]);
            try
            {
                var data = DataManagerInstance();
                var settings = data == null ? null : GetFieldOrProp(data, "SettingData");
                if (settings != null)
                {
                    var f = settings.GetType().GetField("TileIndex", Any);
                    if (f != null) f.SetValue(settings, idx);
                    else SetProp(settings, "TileIndex", idx);
                }

                // Repaint every live tile. Without this the board keeps the old colours
                // until something else re-runs TileVisual.ChangeTileScheme.
                var cust = Instance("Blukulele.CHE.CustomizationManager");
                var evt = cust?.GetType().GetField("OnChangeScheme", Any)?.GetValue(cust) as Delegate;
                evt?.DynamicInvoke(idx);

                console.PrintInfo($"board scheme -> [{idx}] {id}");
            }
            catch (Exception ex) { console.PrintWarn("scheme set failed: " + Short(ex)); }
        }

        private static void UnlockScheme(IConsoleApi console, string[] args)
        {
            if (args == null || args.Length < 1) { console.PrintWarn("usage: scheme unlock <id|all>"); return; }
            var schemes = SchemeCatalogue();
            if (schemes.Length == 0) { console.PrintWarn("Library not ready - reach the main menu first."); return; }

            var unlocker = Instance("Blukulele.CHE.SchemeUnlockerManager");
            if (unlocker == null) { console.PrintWarn("SchemeUnlockerManager not ready."); return; }

            var query = string.Join(" ", args);
            var targets = Norm(query) == "all"
                ? schemes.Select(SchemeId).Where(s => !string.IsNullOrEmpty(s)).ToArray()
                : new[] { SchemeId(schemes.ElementAtOrDefault(Math.Max(0, ResolveSchemeIndex(schemes, query)))) };

            if (targets.Length == 0 || targets[0] == null) { console.PrintWarn($"unknown scheme '{query}'. Try: list schemes"); return; }

            int n = 0;
            foreach (var id in targets)
            {
                try { Invoke(unlocker, "UnlockScheme", id); n++; }
                catch (Exception ex) { console.PrintWarn($"unlock '{id}' failed: " + Short(ex)); }
            }
            console.PrintInfo($"unlocked {n} scheme(s): {string.Join(", ", targets)}");
        }

        private static IEnumerable<string> CompleteSchemeNames(string[] args, int argIndex)
        {
            if (args == null) return Enumerable.Empty<string>();
            return CompleteIdTail(SchemeCatalogue().Select(SchemeId), args, 0, argIndex);
        }

        private static void Give(IConsoleApi console, string[] args)
        {
            if (args == null || args.Length < 2)
            {
                console.PrintWarn("usage: give money <amount> | give piece <piece> [amount] | give gambit <name> [amount]");
                return;
            }

            switch (Norm(args[0]))
            {
                case "money":
                case "coin":
                case "coins":
                    if (!TryInt(args[1], out var amount)) { console.PrintWarn("money amount must be a number."); return; }
                    AddMoney(console, amount);
                    return;

                case "piece":
                    if (args.Length < 2) { console.PrintWarn("usage: give piece <pawn|rook|knight|bishop|queen|king> [amount]"); return; }
                    var pieceAmount = args.Length >= 3 && TryInt(args[2], out var pa) ? Math.Max(1, pa) : 1;
                    GivePiece(console, args[1], pieceAmount);
                    return;

                case "gambit":
                    var gambitAmount = args.Length >= 3 && TryInt(args[args.Length - 1], out var ga) ? Math.Max(1, ga) : 1;
                    var nameParts = args.Skip(1).Take(args.Length - 1 - (args.Length >= 3 && TryInt(args[args.Length - 1], out _) ? 1 : 0));
                    GiveGambit(console, string.Join(" ", nameParts.ToArray()), gambitAmount);
                    return;

                default:
                    console.PrintWarn("unknown give target. Use money, piece, or gambit.");
                    return;
            }
        }

        private static void AddMoney(IConsoleApi console, int amount)
        {
            var chess = Instance("Blukulele.CHE.ChessDataManager");
            if (chess == null) { console.PrintWarn("ChessDataManager not ready - start/load a run first."); return; }
            try
            {
                if (amount >= 0) Invoke(chess, "IncreaseCoin", amount);
                else Invoke(chess, "DecreaseCoin", -amount);
                TryInvoke(chess, "IncreaseTextCoin", true);
                console.PrintInfo($"money {(amount >= 0 ? "+" : "")}{amount}; now {GetProp(chess, "Coins")}");
            }
            catch (Exception ex) { console.PrintWarn("give money failed: " + Short(ex)); }
        }

        private static void SetMoney(IConsoleApi console, string[] args)
        {
            if (args == null || args.Length < 1 || !TryInt(args[0], out var target))
            {
                console.PrintWarn("usage: set money <amount>");
                return;
            }
            var chess = Instance("Blukulele.CHE.ChessDataManager");
            if (chess == null) { console.PrintWarn("ChessDataManager not ready - start/load a run first."); return; }
            var current = Convert.ToInt32(GetProp(chess, "Coins"));
            AddMoney(console, target - current);
        }

        private static void GivePiece(IConsoleApi console, string pieceName, int amount)
        {
            var stock = Instance("Blukulele.CHE.StockManager");
            if (stock == null) { console.PrintWarn("StockManager not ready - start/load a run first."); return; }
            var pieceEnum = ParsePiece(pieceName);
            if (pieceEnum == null) { console.PrintWarn("unknown piece. Use: " + string.Join(", ", PieceNames)); return; }

            try
            {
                // Use the full AddPiece(piece, sourcePosition, ...) overload, not
                // AddPiece(piece, bool). The short overload only fills the internal
                // StockManager.Pieces array; it does not set CurrentTile/Tile.Piece
                // or run the same placement follow-up, leaving ghost-ish pieces that
                // can be sold but not moved/selected correctly.
                var method = stock.GetType().GetMethods().FirstOrDefault(m =>
                {
                    if (m.Name != "AddPiece") return false;
                    var p = m.GetParameters();
                    return p.Length >= 2 && p[0].ParameterType.IsEnum && p[1].ParameterType == typeof(Vector3);
                });
                if (method == null) { console.PrintWarn("StockManager.AddPiece(piece, Vector3, ...) not found."); return; }

                int given = 0;
                for (int i = 0; i < amount; i++)
                {
                    var freePos = FindFreeStockSlotPosition(stock) ?? ((Component)stock).transform.position;
                    var p = method.GetParameters();
                    var call = new object[p.Length];
                    call[0] = pieceEnum;
                    call[1] = freePos;
                    for (int j = 2; j < call.Length; j++) call[j] = p[j].DefaultValue is DBNull ? false : p[j].DefaultValue;
                    method.Invoke(stock, call);
                    given++;
                }
                console.PrintInfo($"gave {given} {pieceName}(s) to stock.");
            }
            catch (Exception ex) { console.PrintWarn("give piece failed: " + Short(ex)); }
        }

        private static void GiveGambit(IConsoleApi console, string query, int amount)
        {
            var lib = Instance("Blukulele.CHE.GambitLibrary");
            var manager = Instance("Blukulele.CHE.GambitManager");
            if (lib == null || manager == null) { console.PrintWarn("Gambit systems not ready - start/load a run first."); return; }
            var gambit = FindGambit(query);
            if (gambit == null) { console.PrintWarn($"unknown gambit '{query}'. Try: list gambits {query}"); return; }

            try
            {
                var id = (string)Field(gambit, "ID").GetValue(gambit);
                var isFull = (bool)Invoke(manager, "IsFull");
                if (isFull) { console.PrintWarn("gambit bar is full."); return; }
                int given = 0;
                for (int i = 0; i < amount; i++)
                {
                    if ((bool)Invoke(manager, "IsFull")) break;
                    Invoke(lib, "SpawnGambit", id, ((Component)manager).transform);
                    given++;
                }
                console.PrintInfo($"gave {given} gambit(s): {id}");
            }
            catch (Exception ex) { console.PrintWarn("give gambit failed: " + Short(ex)); }
        }

        private static void PrintRunState(IConsoleApi console)
        {
            var gm = Instance("Blukulele.Core.GameManager");
            var chess = Instance("Blukulele.CHE.ChessDataManager");
            if (gm != null) console.PrintInfo($"state: {GetFieldOrProp(gm, "CurrentState")} (prev {GetFieldOrProp(gm, "PreviousState")})");
            if (chess != null) console.PrintInfo($"money: {GetProp(chess, "Coins")} | wave: {GetProp(chess, "CurrentWave")}/{GetProp(chess, "LastWave")}");
            var stock = Instance("Blukulele.CHE.StockManager");
            if (stock != null) console.PrintInfo($"stock: {Invoke(stock, "GetPieceInStockCount")}/{Invoke(stock, "GetMaxCount")}");
            var gambitMgr = Instance("Blukulele.CHE.GambitManager");
            if (gambitMgr != null) console.PrintInfo($"gambits full: {Invoke(gambitMgr, "IsFull")}");
        }

        private static void SetWave(IConsoleApi console, string[] args)
        {
            if (args == null || args.Length < 1 || !TryInt(args[0], out var wave)) { console.PrintWarn("usage: wave set <number>"); return; }
            var chess = Instance("Blukulele.CHE.ChessDataManager");
            if (chess == null) { console.PrintWarn("ChessDataManager not ready."); return; }
            SetProp(chess, "CurrentWave", Math.Max(0, wave));
            console.PrintInfo($"wave set to {GetProp(chess, "CurrentWave")}");
        }

        private static void AddWave(IConsoleApi console, string[] args)
        {
            if (args == null || args.Length < 1 || !TryInt(args[0], out var delta)) { console.PrintWarn("usage: wave add <number>"); return; }
            var chess = Instance("Blukulele.CHE.ChessDataManager");
            if (chess == null) { console.PrintWarn("ChessDataManager not ready."); return; }
            var current = Convert.ToInt32(GetProp(chess, "CurrentWave"));
            SetProp(chess, "CurrentWave", Math.Max(0, current + delta));
            console.PrintInfo($"wave is now {GetProp(chess, "CurrentWave")}");
        }

        private static void ListGambits(IConsoleApi console, string[] args)
        {
            var filter = args != null && args.Length > 0 ? string.Join(" ", args) : "";
            var matches = GambitIds(filter).Take(40).ToArray();
            console.PrintInfo(matches.Length == 0 ? "no gambits matched." : string.Join(", ", matches));
        }

        private static Vector3? FindFreeStockSlotPosition(object stock)
        {
            try
            {
                var places = GetProp(stock, "Places") as IEnumerable;
                if (places == null) return null;
                foreach (var place in places)
                {
                    if (place == null) continue;
                    var c = (Component)place;
                    var hasPiece = c.GetComponentInChildren(GameType("Blukulele.CHE.BasePieceBehaviour"), true) != null;
                    if (!hasPiece) return c.transform.position;
                }
            }
            catch { }
            return null;
        }

        private static IEnumerable<string> CompleteGive(string[] args, int argIndex)
        {
            if (args == null || argIndex <= 0) return new[] { "money", "piece", "gambit" };
            var head = Norm(args[0]);
            if (head == "piece") return argIndex == 1 ? PieceNames : Enumerable.Empty<string>();
            if (head == "gambit") return CompleteIdTail(GambitIds(""), args, 1, argIndex);
            return Enumerable.Empty<string>();
        }

        private static IEnumerable<string> CompleteGambitNames(string[] args, int argIndex) => CompleteIdTail(GambitIds(""), args, 0, argIndex);

        // Completes one argument of a possibly multi-word id ("thunder strike" is
        // typed as two args). Given the id words already typed before the argument
        // being completed, suggests each matching id's remaining words; the console
        // filters those against the partial token and rebuilds the input line.
        private static IEnumerable<string> CompleteIdTail(IEnumerable<string> ids, string[] args, int firstIdArg, int argIndex)
        {
            var typed = args.Skip(firstIdArg).Take(Math.Max(0, argIndex - firstIdArg)).ToArray();
            var results = new List<string>();
            foreach (var id in ids)
            {
                if (string.IsNullOrEmpty(id)) continue;
                var words = id.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
                if (words.Length <= typed.Length) continue; // fully typed already
                bool match = true;
                for (int i = 0; i < typed.Length && match; i++)
                    match = Norm(words[i]) == Norm(typed[i]);
                if (match) results.Add(string.Join(" ", words.Skip(typed.Length).ToArray()));
            }
            return results.Distinct();
        }

        private static IEnumerable<string> GambitIds(string filter)
        {
            var lib = Instance("Blukulele.CHE.GambitLibrary");
            if (lib == null) return Enumerable.Empty<string>();
            var field = Field(lib, "GambitsInfo");
            if (field == null || !(field.GetValue(lib) is IEnumerable list)) return Enumerable.Empty<string>();
            var nf = Norm(filter);
            return list.Cast<object>()
                .Select(g => (string)Field(g, "ID")?.GetValue(g))
                .Where(id => !string.IsNullOrEmpty(id))
                .Where(id => string.IsNullOrEmpty(nf) || Norm(id).Contains(nf))
                .OrderBy(id => id);
        }

        private static object FindGambit(string query)
        {
            var lib = Instance("Blukulele.CHE.GambitLibrary");
            var field = Field(lib, "GambitsInfo");
            if (field == null || !(field.GetValue(lib) is IEnumerable list)) return null;
            var q = Norm(query);
            if (string.IsNullOrEmpty(q)) return null;
            var gambits = list.Cast<object>().ToArray();
            return gambits.FirstOrDefault(g => Norm((string)Field(g, "ID")?.GetValue(g)) == q)
                ?? gambits.FirstOrDefault(g => Norm(((string)Field(g, "ID")?.GetValue(g)) ?? "").Contains(q))
                ?? gambits.FirstOrDefault(g => Norm(((string)Field(g, "GambitName")?.GetValue(g)) ?? "").Replace("name", "").Contains(q));
        }

        private static object ParsePiece(string name)
        {
            var enumType = GameType("Blukulele.CHE.PieceType");
            if (enumType == null) return null;
            var n = Norm(name);
            if (n == "horse") n = "knight";
            if (!PieceNames.Contains(n)) return null;
            return Enum.Parse(enumType, n.ToUpperInvariant());
        }

        private static object Instance(string typeName)
        {
            var t = GameType(typeName);
            if (t == null) return null;
            try
            {
                var all = Resources.FindObjectsOfTypeAll(t).Cast<object>().Where(o => o != null).ToArray();
                return all.FirstOrDefault(o => o is Component c && c.gameObject.scene.isLoaded)
                    ?? all.FirstOrDefault();
            }
            catch { return null; }
        }

        private static Type GameType(string name) => AppDomain.CurrentDomain.GetAssemblies()
            .Select(a => a.GetType(name, throwOnError: false))
            .FirstOrDefault(t => t != null);

        private static object Invoke(object target, string name, params object[] args) => target.GetType().GetMethod(name, Any)?.Invoke(target, args);
        private static void TryInvoke(object target, string name, params object[] args) { try { Invoke(target, name, args); } catch { } }
        private static object GetProp(object target, string name) => target.GetType().GetProperty(name, Any)?.GetValue(target, null);
        private static void SetProp(object target, string name, object value) => target.GetType().GetProperty(name, Any)?.SetValue(target, value, null);
        private static object GetFieldOrProp(object target, string name) => target.GetType().GetField(name, Any)?.GetValue(target) ?? GetProp(target, name);
        private static FieldInfo Field(object target, string name) => target?.GetType().GetField(name, Any);
        private const BindingFlags Any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
        private static string Norm(string s) => (s ?? "").Trim().ToLowerInvariant().Replace("_", "-");
        private static bool TryInt(string s, out int value) => int.TryParse(s, out value);
        private static string Short(Exception ex) => ex is TargetInvocationException tie && tie.InnerException != null ? tie.InnerException.Message : ex.Message;
    }
}
