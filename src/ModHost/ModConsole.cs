using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Gambonanza.ModSdk;
using TMPro;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace Gambonanza.ModHost
{
    [DefaultExecutionOrder(-10000)]
    internal sealed class ModConsole : MonoBehaviour, IConsoleApi
    {
        private sealed class Command
        {
            public string Name;
            public string Description;
            public Action<string[]> Handler;
            public ConsoleArgumentCompleter Completer;
        }

        private sealed class KeybindCapture
        {
            public string ModId;
            public string Name;
        }

        private readonly Dictionary<string, Command> _commands = new Dictionary<string, Command>();
        private readonly List<string> _lines = new List<string>();
        private readonly List<string> _suggestions = new List<string>();
        private readonly List<string> _history = new List<string>();

        private Canvas _canvas;
        private RectTransform _root;
        private ScrollRect _outputScroll;
        private RectTransform _outputContent;
        private TextMeshProUGUI _output;
        private TMP_InputField _input;
        private TextMeshProUGUI _inputPreview;
        private TextMeshProUGUI _inputText;
        private TextMeshProUGUI _suggestionsText;
        private bool _open;
        private bool _submitQueued;
        private bool _welcomed;
        private string _lastSubmitted;
        private float _lastSubmitAt;
        private string _completionBaseInput;
        private string _completionAppliedInput;
        private int _completionIndex;
        private int _historyIndex = -1;
        private KeybindCapture _keybindCapture;
        private float _keybindCaptureReadyAt;

        private static readonly Color PanelColor = new Color(0.055f, 0.035f, 0.03f, 0.94f);
        private static readonly Color BorderColor = new Color(0.95f, 0.82f, 0.45f, 1f);
        private static readonly Color TextColor = new Color(1f, 0.94f, 0.72f, 1f);
        private static readonly Color MutedColor = new Color(1f, 0.80f, 0.55f, 0.78f);
        private static readonly Color WarnColor = new Color(1f, 0.55f, 0.35f, 1f);
        private const string Gold = "#ffd36b";
        private const string Blue = "#78c7ff";
        private const string Lime = "#b8ff5f";
        private const string Response = "#aaa39a";

        public static ModConsole Instance { get; private set; }

        public static ModConsole Ensure()
        {
            var existing = Resources.FindObjectsOfTypeAll<ModConsole>().FirstOrDefault();
            if (existing != null)
            {
                Instance = existing;
                return existing;
            }

            var go = new GameObject("__GambonanzaModConsole");
            DontDestroyOnLoad(go);
            go.hideFlags = HideFlags.HideAndDontSave;
            Instance = go.AddComponent<ModConsole>();
            return Instance;
        }

        private void Awake()
        {
            Instance = this;
            RegisterCommand("help", "list console commands", _ => PrintHelp());
            RegisterCommand("clear", "clear console output", _ => { _lines.Clear(); RefreshOutput(); });
            RegisterCommand("mods", "list loaded mods", _ => PrintMods());
            RegisterCommand("mods rescan", "rescan the Mods folder", _ =>
            {
                var count = ModHost.Rescan();
                PrintInfo(count > 0 ? $"loaded {count} new mod(s)." : "no new mods found.");
            });
            RegisterCommand("mods folder", "open the Mods folder", _ => ModHost.OpenModsFolderInFinder());
            RegisterCommand("mods enable", "enable a mod: mods enable <id>", args => SetModEnabled(args, true), CompleteModIds);
            RegisterCommand("mods disable", "disable a mod: mods disable <id>", args => SetModEnabled(args, false), CompleteModIds);
            RegisterCommand("achievements", "Steam achievements while modded: achievements [on|off] (paused by default while any mod is enabled)", Achievements, CompleteOnOff);
            RegisterCommand("keybinds", "list keybinds: keybinds [mod]", PrintKeybinds, CompleteModIds);
            RegisterCommand("keybind", "set keybind: keybind <mod> <name> then press a key/combo", BeginKeybindCapture, CompleteKeybindCommand);
            RegisterCommand("keybind unset", "unset keybind: keybind unset <mod> <name>", UnsetKeybind, CompleteKeybindCommandUnset);
            ModCheats.Register(this);
            PrintInfo("console ready. Press ` or F10 to toggle. Type 'help' for commands.");
        }

        public bool IsOpen => _open;

        public void Open() => SetOpen(true);

        public void Close() => SetOpen(false);

        public void Toggle() => SetOpen(!_open);

        private void Update()
        {
            if (_keybindCapture != null)
            {
                PollKeybindCapture();
                return;
            }

            if (Input.GetKeyDown(KeyCode.BackQuote) || Input.GetKeyDown(KeyCode.F10))
            {
                Toggle();
                return;
            }

            if (!_open) return;

            if (Input.GetKeyDown(KeyCode.Escape))
            {
                SuppressPauseButtonForEscapeFrame();
                SetOpen(false);
                return;
            }

            if (Input.GetKeyDown(KeyCode.UpArrow))
            {
                RecallHistory(-1);
                return;
            }

            if (Input.GetKeyDown(KeyCode.DownArrow))
            {
                RecallHistory(1);
                return;
            }

            if (Input.GetKeyDown(KeyCode.Tab))
            {
                AcceptSuggestion();
                return;
            }

            // TMP_InputField.onSubmit is the normal path. This fallback covers
            // Unity/EventSystem focus weirdness in the game menus.
            if (Input.GetKeyDown(KeyCode.Return) || Input.GetKeyDown(KeyCode.KeypadEnter))
                _submitQueued = true;
        }

        private void LateUpdate()
        {
            if (!_open) return;

            if (_submitQueued)
            {
                _submitQueued = false;
                SubmitCurrentInput();
            }
        }

        public void RegisterCommand(string name, string description, Action<string[]> handler, ConsoleArgumentCompleter completer = null)
        {
            if (string.IsNullOrEmpty(name) || handler == null) return;
            var key = Normalize(name);
            _commands[key] = new Command
            {
                Name = key,
                Description = description ?? "",
                Handler = handler,
                Completer = completer,
            };
            RefreshSuggestions();
            ModHost.LogLine($"console command registered: {key}");
        }

        public void UnregisterCommand(string name)
        {
            if (string.IsNullOrEmpty(name)) return;
            _commands.Remove(Normalize(name));
            RefreshSuggestions();
        }

        public void Print(string message, ConsoleLineColor color = ConsoleLineColor.Default)
        {
            switch (color)
            {
                case ConsoleLineColor.Warn:
                    PrintWarn(message);
                    break;
                case ConsoleLineColor.Error:
                    PrintError(message);
                    break;
                case ConsoleLineColor.Echo:
                    AddLine($"<color={Gold}>></color> " + ColorizeCommand((message ?? "").TrimStart('>', ' ')));
                    break;
                default:
                    PrintInfo(message);
                    break;
            }
        }

        public void PrintInfo(string message)
        {
            AddLine($"<color={Response}>" + Escape(message) + "</color>");
            try { Debug.Log("[ModConsole] " + message); } catch { }
        }

        public void PrintWarn(string message)
        {
            AddLine("<color=#ff8c59>[warn]</color> " + Escape(message));
            try { Debug.LogWarning("[ModConsole] " + message); } catch { }
        }

        public void PrintError(string message)
        {
            AddLine("<color=#ff5f5f>[error]</color> " + Escape(message));
            try { Debug.LogError("[ModConsole] " + message); } catch { }
        }

        internal void PrintRich(string richText)
        {
            AddLine(richText ?? "");
        }

        private void SetOpen(bool open)
        {
            _open = open;
            EnsureUi();
            _canvas.gameObject.SetActive(open);
            if (open)
            {
                PrintWelcomeIfNeeded();
                RefreshOutput();
                RefreshSuggestions();
                FocusInput();
            }
        }

        private void PrintWelcomeIfNeeded()
        {
            if (_welcomed) return;
            _welcomed = true;
            PrintInfo("Welcome to the Gambonanza console.");
            PrintInfo("Open/close it anytime with F10 or `.");
            PrintInfo("Examples: give money 100 | give piece queen 2 | give gambit thunder | run");
            PrintInfo("Tip: press Tab to autocomplete; keep pressing Tab to cycle suggestions.");
        }

        private void EnsureUi()
        {
            if (_canvas != null) return;
            EnsureEventSystem();

            var canvasGo = new GameObject("__GambonanzaModConsoleCanvas");
            DontDestroyOnLoad(canvasGo);
            canvasGo.hideFlags = HideFlags.HideAndDontSave;
            _canvas = canvasGo.AddComponent<Canvas>();
            _canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            _canvas.sortingOrder = short.MaxValue;
            canvasGo.AddComponent<CanvasScaler>().uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            canvasGo.GetComponent<CanvasScaler>().referenceResolution = new Vector2(1920, 1080);
            canvasGo.GetComponent<CanvasScaler>().matchWidthOrHeight = 0.5f;
            canvasGo.AddComponent<GraphicRaycaster>();

            _root = CreateRect("Panel", canvasGo.transform);
            _root.anchorMin = new Vector2(0.035f, 0.06f);
            _root.anchorMax = new Vector2(0.965f, 0.94f);
            _root.offsetMin = Vector2.zero;
            _root.offsetMax = Vector2.zero;
            AddImage(_root.gameObject, PanelColor);
            AddOutline(_root.gameObject, BorderColor, 4f);

            var header = CreateText("Header", _root, "GAMBONANZA CONSOLE", 34, TextAlignmentOptions.Left, BorderColor);
            header.rectTransform.anchorMin = new Vector2(0.03f, 0.91f);
            header.rectTransform.anchorMax = new Vector2(0.86f, 0.985f);
            header.rectTransform.offsetMin = Vector2.zero;
            header.rectTransform.offsetMax = Vector2.zero;
            header.fontStyle = FontStyles.Bold;

            var hint = CreateText("Hint", _root, "Enter: run   Tab: autocomplete   Esc: close   ` / F10: toggle", 20, TextAlignmentOptions.Right, MutedColor);
            hint.rectTransform.anchorMin = new Vector2(0.36f, 0.91f);
            hint.rectTransform.anchorMax = new Vector2(0.94f, 0.982f);
            hint.rectTransform.offsetMin = Vector2.zero;
            hint.rectTransform.offsetMax = Vector2.zero;

            var close = CreateButton("Close", _root, "X", 28, () => SetOpen(false));
            close.anchorMin = new Vector2(0.945f, 0.92f);
            close.anchorMax = new Vector2(0.985f, 0.98f);
            close.offsetMin = Vector2.zero;
            close.offsetMax = Vector2.zero;

            var outputBg = CreateRect("OutputBg", _root);
            outputBg.anchorMin = new Vector2(0.03f, 0.23f);
            outputBg.anchorMax = new Vector2(0.97f, 0.895f);
            outputBg.offsetMin = Vector2.zero;
            outputBg.offsetMax = Vector2.zero;
            AddImage(outputBg.gameObject, new Color(0.02f, 0.014f, 0.012f, 0.72f));

            _outputScroll = outputBg.gameObject.AddComponent<ScrollRect>();
            _outputScroll.horizontal = false;
            _outputScroll.vertical = true;
            _outputScroll.movementType = ScrollRect.MovementType.Clamped;
            _outputScroll.scrollSensitivity = 34f;

            var outputViewport = CreateRect("Viewport", outputBg);
            outputViewport.anchorMin = new Vector2(0.018f, 0.035f);
            outputViewport.anchorMax = new Vector2(0.982f, 0.965f);
            outputViewport.offsetMin = Vector2.zero;
            outputViewport.offsetMax = Vector2.zero;
            outputViewport.gameObject.AddComponent<RectMask2D>();
            _outputScroll.viewport = outputViewport;

            _outputContent = CreateRect("Content", outputViewport);
            _outputContent.anchorMin = new Vector2(0f, 1f);
            _outputContent.anchorMax = new Vector2(1f, 1f);
            _outputContent.pivot = new Vector2(0f, 1f);
            _outputContent.offsetMin = Vector2.zero;
            _outputContent.offsetMax = Vector2.zero;
            _outputScroll.content = _outputContent;

            _output = CreateText("Output", _outputContent, "", 24, TextAlignmentOptions.TopLeft, TextColor);
            _output.rectTransform.anchorMin = new Vector2(0f, 1f);
            _output.rectTransform.anchorMax = new Vector2(1f, 1f);
            _output.rectTransform.pivot = new Vector2(0f, 1f);
            _output.rectTransform.offsetMin = new Vector2(0f, 0f);
            _output.rectTransform.offsetMax = new Vector2(0f, 0f);
            _output.textWrappingMode = TextWrappingModes.Normal;
            _output.overflowMode = TextOverflowModes.Overflow;
            _output.lineSpacing = 8f;

            var suggestBg = CreateRect("SuggestionsBg", _root);
            suggestBg.anchorMin = new Vector2(0.03f, 0.125f);
            suggestBg.anchorMax = new Vector2(0.97f, 0.215f);
            suggestBg.offsetMin = Vector2.zero;
            suggestBg.offsetMax = Vector2.zero;
            AddImage(suggestBg.gameObject, new Color(0.10f, 0.055f, 0.035f, 0.90f));
            _suggestionsText = CreateText("Suggestions", suggestBg, "", 20, TextAlignmentOptions.Left, MutedColor);
            _suggestionsText.rectTransform.anchorMin = new Vector2(0.018f, 0.08f);
            _suggestionsText.rectTransform.anchorMax = new Vector2(0.982f, 0.92f);
            _suggestionsText.rectTransform.offsetMin = Vector2.zero;
            _suggestionsText.rectTransform.offsetMax = Vector2.zero;
            _suggestionsText.textWrappingMode = TextWrappingModes.NoWrap;
            _suggestionsText.overflowMode = TextOverflowModes.Ellipsis;

            CreateInput(_root);
            _canvas.gameObject.SetActive(false);
        }

        private void CreateInput(RectTransform parent)
        {
            var inputRoot = CreateRect("Input", parent);
            inputRoot.anchorMin = new Vector2(0.03f, 0.035f);
            inputRoot.anchorMax = new Vector2(0.97f, 0.115f);
            inputRoot.offsetMin = Vector2.zero;
            inputRoot.offsetMax = Vector2.zero;
            AddImage(inputRoot.gameObject, new Color(0.035f, 0.022f, 0.018f, 0.96f));
            AddOutline(inputRoot.gameObject, BorderColor, 3f);

            _input = inputRoot.gameObject.AddComponent<TMP_InputField>();
            _input.lineType = TMP_InputField.LineType.SingleLine;
            _input.characterValidation = TMP_InputField.CharacterValidation.None;
            _input.shouldHideMobileInput = false;
            _input.customCaretColor = true;
            _input.caretColor = new Color(1f, 0.83f, 0.42f, 0.9f);
            _input.caretWidth = 11;
            _input.onSubmit.AddListener(_ => SubmitCurrentInput());
            _input.onValueChanged.AddListener(_ => { RefreshInputPreview(); RefreshSuggestions(); });

            var viewport = CreateRect("TextViewport", inputRoot);
            viewport.anchorMin = new Vector2(0.02f, 0f);
            viewport.anchorMax = new Vector2(0.98f, 1f);
            viewport.offsetMin = Vector2.zero;
            viewport.offsetMax = Vector2.zero;
            var mask = viewport.gameObject.AddComponent<RectMask2D>();
            mask.padding = Vector4.zero;

            _inputPreview = CreateText("Preview", viewport, "", 28, TextAlignmentOptions.MidlineLeft, TextColor);
            _inputPreview.rectTransform.anchorMin = Vector2.zero;
            _inputPreview.rectTransform.anchorMax = Vector2.one;
            _inputPreview.rectTransform.offsetMin = Vector2.zero;
            _inputPreview.rectTransform.offsetMax = Vector2.zero;
            _inputPreview.textWrappingMode = TextWrappingModes.NoWrap;
            _inputPreview.richText = true;

            _inputText = CreateText("Text", viewport, "", 28, TextAlignmentOptions.MidlineLeft, new Color(1f, 0.94f, 0.72f, 0.02f));
            _inputText.rectTransform.anchorMin = Vector2.zero;
            _inputText.rectTransform.anchorMax = Vector2.one;
            _inputText.rectTransform.offsetMin = Vector2.zero;
            _inputText.rectTransform.offsetMax = Vector2.zero;
            _inputText.textWrappingMode = TextWrappingModes.NoWrap;

            // Use TMP_InputField's own caret as the block cursor. A separate
            // overlay cursor can accidentally measure the placeholder text and
            // jump to the end of "type a command…" when the input is empty.

            var placeholder = CreateText("Placeholder", viewport, "type a command…", 28, TextAlignmentOptions.MidlineLeft, new Color(1f, 0.94f, 0.72f, 0.45f));
            placeholder.rectTransform.anchorMin = Vector2.zero;
            placeholder.rectTransform.anchorMax = Vector2.one;
            placeholder.rectTransform.offsetMin = Vector2.zero;
            placeholder.rectTransform.offsetMax = Vector2.zero;
            placeholder.fontStyle = FontStyles.Italic;

            _input.textViewport = viewport;
            _input.textComponent = _inputText;
            _input.placeholder = placeholder;
            _input.targetGraphic = inputRoot.GetComponent<Image>();
        }

        private void SubmitCurrentInput()
        {
            if (_input == null) return;
            var line = (_input.text ?? "").Trim();
            if (line.Length == 0) { FocusInput(); return; }

            // Guard against receiving both onSubmit and the Update fallback for the
            // same Enter press.
            if (line == _lastSubmitted && Time.realtimeSinceStartup - _lastSubmitAt < 0.15f)
            {
                FocusInput();
                return;
            }
            _lastSubmitted = line;
            _lastSubmitAt = Time.realtimeSinceStartup;

            if (_history.Count == 0 || !string.Equals(_history[_history.Count - 1], line, StringComparison.Ordinal))
            {
                _history.Add(line);
                while (_history.Count > 100) _history.RemoveAt(0);
            }
            _historyIndex = _history.Count;

            _input.text = "";
            RefreshInputPreview();
            Execute(line);
            RefreshSuggestions();
            FocusInput();
        }

        private void RecallHistory(int direction)
        {
            if (_input == null || _history.Count == 0) return;

            if (direction < 0)
            {
                if (_historyIndex < 0 || _historyIndex > _history.Count) _historyIndex = _history.Count;
                _historyIndex = Math.Max(0, _historyIndex - 1);
            }
            else
            {
                if (_historyIndex < 0) return;
                _historyIndex++;
                if (_historyIndex >= _history.Count)
                {
                    _historyIndex = _history.Count;
                    _input.text = "";
                    RefreshInputPreview();
                    RefreshSuggestions();
                    FocusInput();
                    return;
                }
            }

            _input.text = _history[_historyIndex];
            _input.caretPosition = _input.text.Length;
            RefreshInputPreview();
            RefreshSuggestions();
            FocusInput();
        }

        private void Execute(string line)
        {
            AddLine($"<color={Gold}>></color> " + ColorizeCommand(line));

            var command = FindCommand(line, out var argText);
            if (command == null)
            {
                PrintWarn("unknown command. Type 'help'.");
                return;
            }

            try { command.Handler(SplitArgs(argText).ToArray()); }
            catch (Exception ex) { PrintWarn($"command failed: {ex.Message}"); }
        }

        private Command FindCommand(string line, out string argText)
        {
            var normalized = Normalize(line);
            foreach (var pair in _commands.OrderByDescending(p => p.Key.Length))
            {
                var key = pair.Key;
                if (normalized == key)
                {
                    argText = "";
                    return pair.Value;
                }
                if (normalized.StartsWith(key + " ", StringComparison.Ordinal))
                {
                    argText = line.Substring(key.Length).TrimStart();
                    return pair.Value;
                }
            }
            argText = "";
            return null;
        }

        private void RefreshSuggestions()
        {
            if (_suggestionsText == null) return;
            _suggestions.Clear();
            _suggestions.AddRange(BuildSuggestionsFor(_input != null ? _input.text ?? "" : ""));

            _suggestionsText.text = _suggestions.Count == 0
                ? ""
                : $"<color={Response}>suggestions:</color> " + string.Join("    ", _suggestions.Take(8).Select(ColorizeCommand).ToArray());
        }

        private List<string> BuildSuggestionsFor(string rawLine)
        {
            var result = new List<string>();
            var line = (rawLine ?? "").TrimStart();
            var normalized = Normalize(line);

            Command exact = null;
            string argText = "";
            if (line.Length > 0) exact = FindCommand(line, out argText);
            if (exact != null && exact.Completer != null)
            {
                try
                {
                    var args = SplitArgsForCompletion(argText).ToArray();
                    var argIndex = Math.Max(0, args.Length - 1);
                    foreach (var s in exact.Completer(args, argIndex) ?? Enumerable.Empty<string>())
                        if (!string.IsNullOrEmpty(s)) result.Add(exact.Name + " " + s);
                }
                catch { }
            }

            if (result.Count == 0)
            {
                foreach (var cmd in _commands.Values.OrderBy(c => c.Name))
                {
                    if (normalized.Length == 0 || cmd.Name.StartsWith(normalized, StringComparison.Ordinal) || cmd.Name.Contains(normalized))
                        result.Add(cmd.Name);
                    if (result.Count >= 8) break;
                }
            }

            return result.Distinct().Take(16).ToList();
        }

        private void RefreshInputPreview()
        {
            if (_inputPreview == null || _input == null) return;
            _inputPreview.text = string.IsNullOrEmpty(_input.text) ? "" : ColorizeCommand(_input.text);
        }

        private void AcceptSuggestion()
        {
            if (_input == null) return;
            var current = _input.text ?? "";
            List<string> candidates;
            if (current == _completionAppliedInput && !string.IsNullOrEmpty(_completionBaseInput))
            {
                candidates = BuildSuggestionsFor(_completionBaseInput);
                if (candidates.Count == 0) return;
                _completionIndex = (_completionIndex + 1) % candidates.Count;
            }
            else
            {
                _completionBaseInput = current;
                candidates = BuildSuggestionsFor(current);
                if (candidates.Count == 0) return;
                _completionIndex = 0;
            }

            _input.text = candidates[_completionIndex];
            _completionAppliedInput = _input.text;
            _input.caretPosition = _input.text.Length;
            RefreshSuggestions();
            FocusInput();
        }

        private IEnumerable<string> CompleteModIds(string[] args, int argIndex)
        {
            var prefix = args != null && args.Length > 0 ? Normalize(args[0]) : "";
            return ModHost.AllMods()
                .Select(m => m.Manifest.id)
                .Where(id => string.IsNullOrEmpty(prefix) || Normalize(id).StartsWith(prefix))
                .OrderBy(id => id)
                .Take(8);
        }

        private void PrintHelp()
        {
            foreach (var cmd in _commands.Values.OrderBy(c => c.Name))
                AddLine(ColorizeCommand(cmd.Name) + $"<pos=360><color={Response}>" + Escape(cmd.Description) + "</color>");
        }

        private void PrintMods()
        {
            var mods = ModHost.AllMods();
            if (mods.Count == 0)
            {
                PrintInfo("no mods loaded.");
                return;
            }
            foreach (var mod in mods)
                PrintInfo($"{mod.Manifest.id} v{mod.Manifest.version} [{(mod.IsActive ? "enabled" : "disabled")}]");
        }

        private void SetModEnabled(string[] args, bool enabled)
        {
            if (args == null || args.Length == 0)
            {
                PrintWarn(enabled ? "usage: mods enable <id>" : "usage: mods disable <id>");
                return;
            }
            string error;
            var ok = enabled ? ModHost.TryEnable(args[0], out error) : ModHost.TryDisable(args[0], out error);
            if (ok && string.IsNullOrEmpty(error)) PrintInfo($"{args[0]} {(enabled ? "enabled" : "disabled")}");
            else PrintWarn(error ?? "failed");
        }

        private void Achievements(string[] args)
        {
            if (args != null && args.Length > 0)
            {
                switch (Normalize(args[0]))
                {
                    case "on":
                    case "allow":
                        ModHost.AchievementsAllowed = true;
                        PrintInfo("Steam achievements are now allowed for this session, even with mods enabled.");
                        PrintInfo("This resets on restart - the next launch pauses them again while a mod is enabled.");
                        return;
                    case "off":
                    case "block":
                        ModHost.AchievementsAllowed = false;
                        PrintInfo("back to default: Steam achievements are paused while at least one mod is enabled.");
                        return;
                    default:
                        PrintWarn("usage: achievements [on|off]");
                        return;
                }
            }

            var modsActive = ModHost.AnyModActive();
            if (ModHost.AchievementsAllowed)
                PrintInfo("achievements: allowed for this session (override; resets on restart). 'achievements off' restores the default pause.");
            else if (modsActive)
                PrintInfo("achievements: paused - at least one mod is enabled. 'achievements on' allows them for this session.");
            else
                PrintInfo("achievements: active - no mods are enabled. They pause automatically while a mod is enabled.");
        }

        private IEnumerable<string> CompleteOnOff(string[] args, int argIndex)
        {
            var prefix = args != null && args.Length > 0 ? Normalize(args[0]) : "";
            return new[] { "on", "off" }.Where(s => s.StartsWith(prefix, StringComparison.Ordinal));
        }

        private void PrintKeybinds(string[] args)
        {
            var modFilter = args != null && args.Length > 0 ? args[0] : null;
            var keybinds = ModHost.AllKeybinds(modFilter).OrderBy(k => k.ModId).ThenBy(k => k.Name).ToArray();
            if (keybinds.Length == 0)
            {
                PrintWarn(string.IsNullOrEmpty(modFilter) ? "no keybinds found." : $"no keybinds found for '{modFilter}'.");
                return;
            }
            string currentMod = null;
            foreach (var kb in keybinds)
            {
                if (!string.Equals(currentMod, kb.ModId, StringComparison.OrdinalIgnoreCase))
                {
                    currentMod = kb.ModId;
                    AddLine(ColorizeCommand(currentMod));
                }
                var key = string.IsNullOrEmpty(kb.Key) ? ModKeybinds.Unset : kb.Key;
                AddLine($"  <color={Blue}>" + Escape(kb.Name) + $"</color><pos=360><color={Lime}>" + Escape(key) + "</color>");
            }
        }

        private void BeginKeybindCapture(string[] args)
        {
            if (args == null || args.Length < 2)
            {
                PrintWarn("usage: keybind <mod> <name>");
                return;
            }
            if (!FindKeybind(args[0], args[1], out var modId, out var name))
            {
                PrintWarn($"unknown keybind '{args[1]}' for mod '{args[0]}'. Try: keybinds {args[0]}");
                return;
            }
            SetOpen(true);
            _keybindCapture = new KeybindCapture { ModId = modId, Name = name };
            _keybindCaptureReadyAt = Time.realtimeSinceStartup + 0.25f;
            if (_input != null) _input.text = "";
            PrintInfo($"press a key for {modId}.{name}; hold Shift/Ctrl/Alt/Cmd first for combos. Esc cancels, Backspace unsets.");
            FocusInput();
        }

        private void UnsetKeybind(string[] args)
        {
            if (args == null || args.Length < 2)
            {
                PrintWarn("usage: keybind unset <mod> <name>");
                return;
            }
            if (!FindKeybind(args[0], args[1], out var modId, out var name))
            {
                PrintWarn($"unknown keybind '{args[1]}' for mod '{args[0]}'. Try: keybinds {args[0]}");
                return;
            }
            string error;
            if (ModHost.TrySetKeybind(modId, name, ModKeybinds.Unset, out error)) PrintInfo($"{modId}.{name} = unset");
            else PrintWarn(error ?? "failed to unset keybind");
        }

        private void PollKeybindCapture()
        {
            if (_keybindCapture == null) return;
            if (Time.realtimeSinceStartup < _keybindCaptureReadyAt) return;
            if (Input.GetKeyDown(KeyCode.Escape))
            {
                PrintInfo("keybind capture cancelled.");
                _keybindCapture = null;
                FocusInput();
                return;
            }
            if (Input.GetKeyDown(KeyCode.Backspace) || Input.GetKeyDown(KeyCode.Delete))
            {
                string unsetError;
                if (ModHost.TrySetKeybind(_keybindCapture.ModId, _keybindCapture.Name, ModKeybinds.Unset, out unsetError))
                    PrintInfo($"{_keybindCapture.ModId}.{_keybindCapture.Name} = unset");
                else PrintWarn(unsetError ?? "failed to unset keybind");
                _keybindCapture = null;
                FocusInput();
                return;
            }

            var key = ModKeybinds.FirstNonModifierKeyDown();
            if (key == KeyCode.None) return;
            var spec = ModKeybinds.CaptureSpec(key);
            string error;
            if (ModHost.TrySetKeybind(_keybindCapture.ModId, _keybindCapture.Name, spec, out error))
                PrintInfo($"{_keybindCapture.ModId}.{_keybindCapture.Name} = {spec}");
            else PrintWarn(error ?? "failed to set keybind");
            _keybindCapture = null;
            if (_input != null) _input.text = "";
            RefreshSuggestions();
            FocusInput();
        }

        private bool FindKeybind(string modQuery, string keyQuery, out string modId, out string name)
        {
            modId = null;
            name = null;
            var keybind = ModHost.AllKeybinds(modQuery).FirstOrDefault(k => string.Equals(k.Name, keyQuery, StringComparison.OrdinalIgnoreCase));
            if (keybind == null) return false;
            modId = keybind.ModId;
            name = keybind.Name;
            return true;
        }

        private IEnumerable<string> CompleteKeybindCommand(string[] args, int argIndex)
        {
            if (args == null || args.Length <= 1) return CompleteModIds(args, argIndex);
            return CompleteKeybindNamesAfterMod(args[0]);
        }

        private IEnumerable<string> CompleteKeybindCommandUnset(string[] args, int argIndex)
        {
            if (args == null || args.Length <= 1) return CompleteModIds(args, argIndex);
            return CompleteKeybindNamesAfterMod(args[0]);
        }

        private IEnumerable<string> CompleteKeybindNamesAfterMod(string modId)
        {
            return ModHost.AllKeybinds(modId)
                .Select(k => modId + " " + k.Name)
                .Distinct()
                .OrderBy(s => s);
        }

        private void AddLine(string line)
        {
            _lines.Add(line ?? "");
            while (_lines.Count > 500) _lines.RemoveAt(0);
            RefreshOutput();
        }

        private void RefreshOutput()
        {
            if (_output == null) return;

            _output.text = string.Join("\n", _lines.ToArray());
            _output.ForceMeshUpdate();

            if (_outputContent != null && _outputScroll != null && _outputScroll.viewport != null)
            {
                var viewportHeight = _outputScroll.viewport.rect.height;
                var preferredHeight = Mathf.Max(viewportHeight, _output.preferredHeight + 18f);
                _outputContent.SetSizeWithCurrentAnchors(RectTransform.Axis.Vertical, preferredHeight);
                _output.rectTransform.SetSizeWithCurrentAnchors(RectTransform.Axis.Vertical, preferredHeight);
                ScrollOutputToBottom();
            }
        }

        private void ScrollOutputToBottom()
        {
            if (_outputScroll == null) return;
            Canvas.ForceUpdateCanvases();
            _outputScroll.verticalNormalizedPosition = 0f;
            Canvas.ForceUpdateCanvases();
        }

        private void FocusInput()
        {
            if (_input == null) return;
            _input.ActivateInputField();
            _input.Select();
            if (EventSystem.current != null)
                EventSystem.current.SetSelectedGameObject(_input.gameObject);
        }

        private void SuppressPauseButtonForEscapeFrame()
        {
            try
            {
                var type = Type.GetType("Blukulele.CHE.PauseButton, Assembly-CSharp");
                if (type == null) return;
                var field = type.GetField("m_CanPause", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                if (field == null) return;
                foreach (var pb in Resources.FindObjectsOfTypeAll(type))
                {
                    if (pb == null) continue;
                    var was = false;
                    try { was = (bool)field.GetValue(pb); field.SetValue(pb, false); }
                    catch { continue; }
                    if (was) StartCoroutine(RestorePauseButtonNextFrame(field, pb));
                }
            }
            catch { }
        }

        private IEnumerator RestorePauseButtonNextFrame(System.Reflection.FieldInfo field, UnityEngine.Object pauseButton)
        {
            yield return null;
            try
            {
                if (pauseButton != null) field.SetValue(pauseButton, true);
            }
            catch { }
        }

        private static void EnsureEventSystem()
        {
            if (EventSystem.current != null) return;
            var go = new GameObject("__GambonanzaModConsoleEventSystem");
            DontDestroyOnLoad(go);
            go.hideFlags = HideFlags.HideAndDontSave;
            go.AddComponent<EventSystem>();
            go.AddComponent<StandaloneInputModule>();
        }

        private static RectTransform CreateRect(string name, Transform parent)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            return (RectTransform)go.transform;
        }

        private static Image AddImage(GameObject go, Color color)
        {
            var img = go.AddComponent<Image>();
            img.color = color;
            return img;
        }

        private static void AddOutline(GameObject go, Color color, float size)
        {
            var outline = go.AddComponent<Outline>();
            outline.effectColor = color;
            outline.effectDistance = new Vector2(size, -size);
        }

        private static TextMeshProUGUI CreateText(string name, Transform parent, string text, float size, TextAlignmentOptions align, Color color)
        {
            var rt = CreateRect(name, parent);
            var tmp = rt.gameObject.AddComponent<TextMeshProUGUI>();
            tmp.text = text ?? "";
            tmp.fontSize = size;
            tmp.alignment = align;
            tmp.color = color;
            tmp.raycastTarget = false;
            return tmp;
        }

        private static RectTransform CreateButton(string name, Transform parent, string label, float fontSize, Action onClick)
        {
            var rt = CreateRect(name, parent);
            AddImage(rt.gameObject, new Color(0.72f, 0.18f, 0.14f, 1f));
            AddOutline(rt.gameObject, BorderColor, 2f);
            var btn = rt.gameObject.AddComponent<Button>();
            btn.onClick.AddListener(() => onClick?.Invoke());
            var txt = CreateText("Text", rt, label, fontSize, TextAlignmentOptions.Center, TextColor);
            txt.rectTransform.anchorMin = Vector2.zero;
            txt.rectTransform.anchorMax = Vector2.one;
            txt.rectTransform.offsetMin = Vector2.zero;
            txt.rectTransform.offsetMax = Vector2.zero;
            txt.fontStyle = FontStyles.Bold;
            return rt;
        }

        private static string Normalize(string s) => (s ?? "").Trim().ToLowerInvariant();

        private static string Escape(string s)
        {
            // TextMeshPro rich text does not decode HTML entities like &lt;.
            // Avoid accidental tag parsing by converting angle brackets to
            // readable placeholder brackets instead.
            return (s ?? "").Replace("<", "[").Replace(">", "]");
        }

        private static string ColorizeCommand(string line)
        {
            var parts = SplitArgs(line).ToArray();
            if (parts.Length == 0) return "";
            var colors = new List<string>();
            var command = Normalize(parts[0]);
            for (int i = 0; i < parts.Length; i++)
            {
                var color = Gold;
                if (i == 0) color = Gold;
                else if (command == "win") color = Lime;
                else if (i == 1) color = Blue;
                else color = Lime;
                colors.Add($"<color={color}>" + Escape(parts[i]) + "</color>");
            }
            return string.Join(" ", colors.ToArray());
        }

        private static IEnumerable<string> SplitArgsForCompletion(string text)
        {
            var parsed = SplitArgs(text).ToList();
            if (!string.IsNullOrEmpty(text) && char.IsWhiteSpace(text[text.Length - 1])) parsed.Add("");
            return parsed;
        }

        private static IEnumerable<string> SplitArgs(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) yield break;
            var current = new System.Text.StringBuilder();
            bool quoted = false;
            for (int i = 0; i < text.Length; i++)
            {
                var ch = text[i];
                if (ch == '"') { quoted = !quoted; continue; }
                if (char.IsWhiteSpace(ch) && !quoted)
                {
                    if (current.Length > 0)
                    {
                        yield return current.ToString();
                        current.Length = 0;
                    }
                    continue;
                }
                current.Append(ch);
            }
            if (current.Length > 0) yield return current.ToString();
        }
    }
}
