# Gambonanza.GameUI - UI API Reference

`Gambonanza.GameUI` is the runtime library every Gambonanza mod uses to build
in-game UI that matches the game's pixel-art style. It ships in `Managed/`
alongside `Gambonanza.ModHost.dll`, so any loaded mod can `using Gambonanza.GameUI;`
and call `Pixel.*` directly.

The library has two jobs:

1. **Create** new game-styled UI (buttons, toggles, labels, modals).
2. **Patch** existing game UI (add a button to the home menu, add a row to the
   settings panel).

It does both by **cloning live game UI** (captured once on first use, cached for
the rest of the session) and stripping the original interactive components, then
attaching fresh handlers. When the relevant game UI hasn't loaded yet, every
factory falls back to a programmatic approximation so your mod still works.

---

## Quick start

```csharp
using Gambonanza.GameUI;
using Gambonanza.ModSdk;

public sealed class HelloMod : IMod
{
    public void OnLoad(IModContext ctx)
    {
        ctx.OnSettingsOpened += settingsCanvas =>
        {
            Pixel.AddSettingsArrowRow(
                settingsCanvas,
                injectedName: "HelloMod_Row",
                title:        "Hello Setting",
                initialValue: "0",
                onLeft:       () => ctx.LogLine("left pressed"),
                onRight:      () => ctx.LogLine("right pressed"));
        };
    }
}
```

---

## Project setup

Add a project reference (or just a DLL reference) to `Gambonanza.GameUI` in your
mod's `.csproj`. Mark it `<Private>false</Private>` so you don't ship a duplicate
(the patcher already installs the real one into `Managed/`.)

```xml
<ItemGroup>
  <ProjectReference Include="..\GameUI\GameUI.csproj">
    <Private>false</Private>
  </ProjectReference>
</ItemGroup>
```

---

## `Pixel` - the public factory

Static class. Every method is safe to call from any thread the game uses for
UI (main thread). All methods return either a Unity component, a wrapper class,
or null on hard failure (logged to `[GameUI]`).

### Buttons

```csharp
public static Button CreateButton(Transform parent, string label, Action onClick);
```

Clones a CanvasMenu home-row button cell into `parent`. The clone has a fresh
`UnityEngine.UI.Button` with default ColorTint colors:

- normal     = white
- highlight  = warm peach
- pressed    = dark amber
- selected   = light peach

Falls back to a programmatic cream button if `CanvasMenu` isn't in the scene yet.

### Toggles (button-style ON / OFF)

```csharp
public static PixelToggle CreateToggle(
    Transform parent, string baseLabel, bool initialOn, Action<bool> onChange);
```

A two-state button. The label flips between `"{baseLabel}: ON"` and
`"{baseLabel}: OFF"`, or just `"ON" / "OFF"` if `baseLabel` is null/empty.

```csharp
var toggle = Pixel.CreateToggle(parent, "GodMode", initialOn: false, isOn => {
    ctx.LogLine("god mode is now " + isOn);
});

// Programmatic flip without firing the callback:
toggle.Set(true, notify: false);
bool currentlyOn = toggle.IsOn;
GameObject root = toggle.Root;       // for layout / parenting
```

### Checkboxes (Settings-style row)

```csharp
public static PixelCheckbox CreateCheckbox(
    Transform parent, string label, bool initialOn, Action<bool> onChange);
```

A row that matches the in-game Settings menu checkboxes - cream rectangle, dark
title text, dark checkmark on the right. Cloned from a live `SettingsCanvas`
Toggle and stripped, so the look is pixel-identical to the game.

```csharp
var cb = Pixel.CreateCheckbox(parent, "Enable Cheats", initialOn: true, isOn => {
    PlayerPrefs.SetInt("cheats", isOn ? 1 : 0);
});

cb.Set(false);                  // also fires the callback
cb.Set(true, notify: false);    // silent
cb.SetLabel("Enable Mega Cheats");
GameObject root = cb.Root;
```

`PixelCheckbox` is the right primitive for any persistent on/off setting in
your mod's UI. `PixelToggle` is better for transient buttons that flip a
value during a single session.

### Labels

```csharp
public static TMP_Text CreateLabel(
    Transform parent, string text, float size,
    Color? color = null,
    TextAlignmentOptions align = TextAlignmentOptions.Center);
```

Programmatic `TextMeshProUGUI`. Picks the best non-fallback `TMP_FontAsset`
loaded in the scene (typically the game's pixel font). `color` defaults to the
game's dark brown text color. `raycastTarget` is disabled so the label never
swallows clicks.

```csharp
public static TMP_FontAsset FindBestFont();   // exposed if you build TMP yourself
```

### Modals

```csharp
public static Modal CreateModal(string name, string title);
```

Returns a `Modal` whose chrome matches the game's Settings panel: full-screen
canvas, dim backdrop, cream-colored panel with the pixel header, and a content
area + status line + toolbar. Cloned from `SettingsCanvas` when possible.

The modal starts **hidden** - call `modal.Show()` when ready.

```csharp
var modal = Pixel.CreateModal("MyMod_Settings", "MY MOD");

Pixel.CreateLabel(modal.Content, "Hello!", 22);
modal.AddToolbarButton("OK",    modal.Hide);
modal.AddToolbarButton("CLOSE", modal.Hide);

modal.Hidden += () => ctx.LogLine("modal closed");
modal.Show();
```

#### `Modal` members

| member                      | what                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| `Root`                      | The root `GameObject` (Canvas when cloned).                           |
| `Content`                   | Where you put your widgets. Already has a `VerticalLayoutGroup`.       |
| `Title`                     | The header `TMP_Text`. Set `.text` to retitle.                         |
| `Toolbar`                   | Bottom-anchored `Transform` with a `HorizontalLayoutGroup`.            |
| `Status`                    | A subtle grey label above the toolbar. Set `.text` to display info.    |
| `Show()` / `Hide()`         | Activate / deactivate `Root`.                                          |
| `AddToolbarButton(l, cb)`   | Convenience: `Pixel.CreateButton(Toolbar, l, cb)`.                     |
| `event Action Hidden`       | Fires after `Hide` runs.                                               |

### Settings arrow row (patches the live SettingsCanvas)

```csharp
public static ArrowRow AddSettingsArrowRow(
    MonoBehaviour settingsCanvas,
    string injectedName,
    string title,
    string initialValue,
    Action onLeft,
    Action onRight);
```

Clones the in-game "Controls" row (left arrow + title + value + right arrow) and
slots it into the gameplay tab of the open `SettingsCanvas`. **Idempotent** -
calling twice with the same `injectedName` returns the existing row instead of
stacking duplicates.

```csharp
private ArrowRow _row;

ctx.OnSettingsOpened += settingsCanvas =>
{
    _row = Pixel.AddSettingsArrowRow(
        settingsCanvas,
        injectedName: "MyMod_Row",
        title:        "Animation Speed",
        initialValue: "1x",
        onLeft:       () => { Speed.Prev(); _row.SetValue(Speed.Label); },
        onRight:      () => { Speed.Next(); _row.SetValue(Speed.Label); });
};
```

`ArrowRow` exposes `SetTitle`, `SetValue`, `Title`, `Value`, `Root`, and
`Remove()` - call `Remove()` from your mod's `IModLifecycle.OnDisable` if you
need clean teardown when the mod is toggled off.

### Home-menu button (patches the live CanvasMenu)

```csharp
public static Button AddHomeMenuButton(
    MonoBehaviour canvasMenu,
    string label,
    string injectedName,
    Action onClick);
```

Clones the Settings cell, retexts it, and slots it as a sibling immediately after
Settings on the bottom row. **Idempotent** - re-call is a no-op.

This is what `ModHost.HomeMenuInjector` uses internally to add the "MODS" entry.

---

## `Hierarchy` - primitives for your own clone-and-patch code

Public helpers that the rest of `Pixel` is built on. Exposed because you may want
to write a clone-and-patch routine for game UI we don't yet wrap.

```csharp
public static List<int> PathFromAncestor(Transform ancestor, Transform descendant);
public static Transform NavigatePath(Transform start, List<int> path);
public static Transform FindCommonAncestor(IList<Transform> transforms);
public static int        DepthOf(Transform t);
public static Transform  FindChildByName(Transform root, string name);
public static MonoBehaviour FindByTypeFullName(string fullName);
```

### The clone-and-strip recipe

This is the pattern every helper in `Pixel` uses internally - recommended for any
mod that wants to extend it:

```csharp
// 1. Find a live instance by reflected type-name (works on inactive objects too).
var canvas = Hierarchy.FindByTypeFullName("Blukulele.CHE.SettingsCanvas");

// 2. Reflect on private [SerializeField] fields to find your landmarks.
//    BindingFlags.NonPublic | BindingFlags.Instance is required.
var title = (TMP_Text)canvas.GetType()
    .GetField("m_TextHeader", BindingFlags.NonPublic | BindingFlags.Instance)
    .GetValue(canvas);

// 3. Compute paths from the root you'll clone down to each landmark.
var titlePath = Hierarchy.PathFromAncestor(canvas.transform, title.transform);

// 4. Clone, strip every interactive (Selectable, EventTrigger, Blukulele.* MBs).
var clone = Object.Instantiate(canvas.gameObject, parent);
// (Strip helpers are internal; mirror them - see GameUI/Internal.cs for reference.)

// 5. Use NavigatePath on the CLONE to find your landmarks again, retext / rewire.
var clonedTitle = Hierarchy.NavigatePath(clone.transform, titlePath)?.GetComponent<TMP_Text>();
clonedTitle.text = "MY HEADER";

// 6. Add fresh Buttons / handlers as needed.
```

### Why "resolve before destroy"

If you destroy children during iteration, sibling indices shift. Any `NavigatePath`
call after a `DestroyImmediate` on the same parent can land on the wrong object.
**Always** resolve every Transform you need (or every Transform you plan to
destroy) into local variables first, then destroy them in a second pass:

```csharp
var toKill = pathsToDestroy
    .Select(p => Hierarchy.NavigatePath(clone.transform, p))
    .Where(t => t != null)
    .ToList();

foreach (var tr in toKill)
    Object.DestroyImmediate(tr.gameObject);
```

This is exactly the bug that left the Graphics + Twitch tabs visible in the
mod-manager modal in earlier iterations. The current `Pixel.CreateModal` does
the resolve-then-destroy pass during template capture; your custom patches
should do the same.

---

## Template lifecycle

| Template       | Captured from                                       | When                          | Cached as                                |
| -------------- | --------------------------------------------------- | ----------------------------- | ---------------------------------------- |
| Button         | `CanvasMenu` Settings cell                          | First `Pixel.CreateButton`    | Inactive GameObject under DontDestroyOnLoad |
| Checkbox       | First `SettingsCanvas` Toggle (any tab, even inactive) | First `Pixel.CreateCheckbox`  | Inactive GameObject under DontDestroyOnLoad |
| Arrow row      | `SettingsCanvas` "Controls" wrapper                 | First `AddSettingsArrowRow`   | Inactive GameObject under DontDestroyOnLoad |
| Modal          | Built fresh each time by cloning the live `Settings Window` panel under a new Canvas | Each `Pixel.CreateModal`     | Not cached - see "Why no modal cache" below |

### Why no modal cache

Modals clone the live `Settings Window` (the cream chrome - header, content area,
close button) into a fresh `Canvas` whose render mode and sorting layer are
**copied from the live `SettingsCanvas`**. This matters: the original Canvas
draws its UI in a sorting layer that sits **above** the game's CRT post-process
shader. Forcing `RenderMode.ScreenSpaceOverlay` would push the modal **below**
the CRT pass, washing out text and breaking colours. By copying the live
canvas's `renderMode`, `worldCamera`, `sortingLayerName`, and `sortingOrder + 1`,
the modal lands in the same render layer as the real Settings panel and looks
identical.

Caching the modal as a deactivated template would freeze its `Canvas` settings
at capture-time, so we just rebuild fresh each time the user opens the modal -
it's once per session in practice (the manager keeps its own instance) and the
extra work is negligible.

Each capture happens at most once per session. If the source isn't in the scene
when the factory is first called, the capture is skipped and the
**programmatic fallback** runs every time thereafter.

The cached template lives under a hidden `__GameUI_TemplateBucket` GameObject
that survives scene loads (`DontDestroyOnLoad` + `HideFlags.HideAndDontSave`).
You'll see it in inspector dumps but not in the active scene UI.

---

## Fallbacks

- **Button** → cream-colored `Image` + `Button` with the same ColorTint defaults.
- **Modal** → fresh `ScreenSpaceOverlay` canvas with a 720×560 cream panel.
- **Arrow row** → no fallback. Returns `null` and logs a warning. (The arrow
  graphics are too specific to the game's atlas to fake convincingly.)
- **Home-menu button** → no fallback. Returns `null` if `CanvasMenu` isn't open.

If you see `[GameUI] modal capture failed` or similar in the log, your mod is
running before the relevant canvas has been instantiated. Defer to a later
event (e.g. `IModContext.OnSettingsOpened`).

---

## Extending the API

If you find yourself patching the same piece of game UI in two mods, that's a
hint to add it to `Pixel`. The recipe:

1. Add a private `Capture<Foo>()` to `Templates.cs` that reflects landmarks,
   clones them under `Bucket.Root()`, strips with `Strip.Interactives`, and
   stores the template + landmark paths in static fields. Always resolve every
   destruction target *before* calling `DestroyImmediate`.
2. Add a public `Pixel.Create<Foo>(...)` (or `Pixel.Add<Foo>(...)` if it patches
   live UI) that calls `Templates.Get<Foo>Template()`, instantiates from cache,
   navigates to landmarks via the cached paths, and retexts/rewires. Provide a
   programmatic fallback when feasible.
3. Update this doc with the new method's signature and a usage snippet.

---

## Color preservation rule

Cloned game UI (button cells, checkbox rows, the Settings Window panel) ships
with its own `Image.color` baked in - usually a cream (`~#EDDCB2`) tint over a
white sprite. **Don't reset `Image.color` to `white` on these clones** - that
washes out the cream and your widget ends up looking pure white instead of
matching the game.

When you add a fresh `Button` to a clone, the `Button`'s `ColorTint` transition
multiplies the target graphic's stored colour by the per-state colour:
- normal `Color.white` → cream * white = cream (looks identical to the game)
- highlighted peach → cream * peach = warm hover tint
- pressed brown → cream * brown = pressed tint

So your sequence on a freshly cloned cell should be:
```csharp
img.raycastTarget = true;     // make sure clicks land
// (don't touch img.color)
var btn = clone.AddComponent<Button>();
btn.targetGraphic = img;
ButtonStyle.ApplyDefaultColors(btn);   // ColorTint white/peach/brown
```

The exception is **arrow buttons in `AddSettingsArrowRow`** - the original
Selectable left a faded "normal" tint on the arrow images, so the helper
explicitly resets those to white before wiring. That's a one-off, not a general
rule.

## Common pitfalls

- **Calling factories before the home menu is open.** The first call lazily
  captures from live game UI; if nothing's there, you get the fallback. If your
  mod needs the real chrome, defer construction until `OnSettingsOpened` or
  `OnHomeMenuOpened` fires (`ModHost` invokes both at the right moment).
- **Forgetting to call `modal.Show()`.** Modals are returned hidden so callers
  can populate before reveal. `CreateButton` / `CreateLabel` / `CreateToggle`
  are returned active.
- **Forgetting `<Private>false</Private>` on the project reference.** Without
  it your mod's `bin/Release/` ends up containing `Gambonanza.GameUI.dll` and
  Unity loads two copies - fields go null in mysterious ways.
- **Re-injecting on every `OnSettingsOpened`.** Pass the same `injectedName`
  every time - `AddSettingsArrowRow` is idempotent and will return the
  existing row instead of duplicating it.
- **Holding a stale `ArrowRow`.** When the SettingsCanvas closes and reopens,
  the inner GameObject hierarchy is rebuilt; subscribe to `OnSettingsOpened`
  and recreate / rebind on every fire.
